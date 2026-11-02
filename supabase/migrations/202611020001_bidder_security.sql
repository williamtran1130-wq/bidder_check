-- Live session checks close the JWT-expiry window after managed sign-out.
-- Auth owns these tables; no application role receives access to their rows.
create function public.has_live_session() returns boolean
language plpgsql stable security definer set search_path='' as $$
declare claims jsonb; session uuid;
begin
 claims:=nullif(current_setting('request.jwt.claims',true),'')::jsonb;
 if claims->>'session_id' is null then return false; end if;
 session:=(claims->>'session_id')::uuid;
 return exists(select 1 from auth.sessions s where s.id=session and s.user_id=auth.uid());
exception when invalid_text_representation then return false;
end $$;

create function public.enforce_live_session() returns void
language plpgsql stable security invoker set search_path='' as $$
begin
 if coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',
    nullif(current_setting('request.jwt.claim.role',true),''))='authenticated' then
  if not public.has_live_session() then
   raise exception 'Your session expired. Sign in again.' using errcode='PT401';
  end if;
 end if;
end $$;
revoke all on function public.has_live_session(),public.enforce_live_session() from public,anon,authenticated,service_role;
grant execute on function public.has_live_session() to authenticated,service_role;
grant execute on function public.enforce_live_session() to anon,authenticated,service_role;

-- Storage does not run the PostgREST hook. Restrictive ANDs with existing rules.
create policy require_live_storage_session on storage.objects as restrictive
 for all to authenticated using ((select public.has_live_session()))
 with check ((select public.has_live_session()));

create function public.revoke_bidder_sessions(p_bidder uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.profiles p join public.bidders b on b.user_id=p.id
   where p.id=p_bidder and p.role='bidder') then raise exception 'Access denied'; end if;
 -- Explicit cleanup also covers legacy refresh tokens without a session FK.
 delete from auth.refresh_tokens where user_id=p_bidder::text;
 delete from auth.sessions where user_id=p_bidder;
end $$;
revoke all on function public.revoke_bidder_sessions(uuid) from public,anon,authenticated,service_role;

alter table public.account_operations drop constraint account_operations_kind_check;
alter table public.account_operations add constraint account_operations_kind_check
 check(kind in ('create_client','create_bidder','update_client','update_bidder','reset_password','sign_out_bidder','set_bidder_password'));
alter table public.account_operations add column password_commitment text
 check(password_commitment is null or password_commitment ~ '^[a-f0-9]{64}$');

-- Do not silently replace a project-specific hook. Deployment must compose it
-- explicitly if one is already installed. Lightweight SQL test harnesses do
-- not have PostgREST's authenticator role.
do $$
declare existing text;
begin
 if exists(select 1 from pg_roles where rolname='authenticator') then
  select substring(setting from length('pgrst.db_pre_request=')+1) into existing
   from pg_roles r cross join lateral unnest(r.rolconfig) setting
   where r.rolname='authenticator' and setting like 'pgrst.db_pre_request=%';
  if nullif(existing,'') is not null and existing<>'public.enforce_live_session' then
   raise exception 'An existing PostgREST request hook must be composed with public.enforce_live_session before deployment';
  end if;
  alter role authenticator set pgrst.db_pre_request='public.enforce_live_session';
 end if;
end $$;
notify pgrst,'reload config';

create or replace function public.begin_account_operation(p_request uuid,p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.account_operations; v jsonb; target uuid; workspace uuid; mail text; fingerprint text;
begin
 if auth.uid() is null then raise exception 'Access denied'; end if;
 if p_request is null then raise exception 'A request id is required'; end if;
 if p_kind not in ('create_client','create_bidder','update_client','update_bidder','reset_password','sign_out_bidder','set_bidder_password') or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid account operation'; end if;
 mail:=nullif(lower(trim(p_payload->>'email')),'');
 v:=case when p_kind in ('reset_password','sign_out_bidder','set_bidder_password') then jsonb_build_object('target',(p_payload->>'target')::uuid)
 else jsonb_build_object('name',case when p_kind='create_bidder' then trim(p_payload->>'name') else left(trim(p_payload->>'name'),100) end,'email',mail) end;
 -- Only normalized, fingerprinted content may reserve an email. In particular,
 -- an extra email field on a password reset has no account-management effect.
 mail:=v->>'email';
 if p_kind not in ('reset_password','sign_out_bidder','set_bidder_password') and (nullif(v->>'name','') is null or (mail is not null and mail !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')) then raise exception 'Valid name and email required'; end if;
 if p_kind like 'create_%' and mail is null then raise exception 'Valid name and email required'; end if;
 if p_kind like 'update_%' then v:=v||jsonb_build_object('target',(p_payload->>'target')::uuid,'archived',coalesce((p_payload->>'archived')::boolean,false)); end if;
 if p_kind in ('create_bidder','update_bidder') then
  if (p_payload->>'rate')::integer not between 0 and 100000000 then raise exception 'Rate is invalid'; end if;
  v:=v||jsonb_build_object('rate',(p_payload->>'rate')::integer);
 end if;
 if p_kind='create_bidder' then v:=v||jsonb_build_object('workspace',(p_payload->>'workspace')::uuid); end if;
 if p_kind='set_bidder_password' then
  if coalesce(p_payload->>'password_commitment','') !~ '^[a-f0-9]{64}$' then raise exception 'Password confirmation required'; end if;
  v:=v||jsonb_build_object('password_commitment',p_payload->>'password_commitment');
 end if;
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('kind',p_kind,'payload',v)::text,'UTF8')),'hex');
 -- Match invite_bidder/sync_auth_email's destination-email synchronization.
 -- Take this before the journal lock, as those legacy paths do before guards.
 if mail is not null then perform pg_advisory_xact_lock(hashtextextended(mail,0)); end if;
 perform pg_advisory_xact_lock(220022);
 select * into o from public.account_operations where request_id=p_request for update;
 if found then
  if o.actor_id<>auth.uid() or not public.account_operation_allowed(o,auth.uid()) then raise exception 'Access denied'; end if;
  if o.fingerprint<>fingerprint then raise exception 'This request ID was already used with different content'; end if;
  return public.account_operation_view(o);
 end if;
 target:=(v->>'target')::uuid; workspace:=(v->>'workspace')::uuid;
 if p_kind in ('sign_out_bidder','set_bidder_password') and not exists(select 1 from public.profiles where id=target and role='bidder') then raise exception 'Access denied'; end if;
 if p_kind='reset_password' and exists(select 1 from public.profiles where id=target and role='bidder') then raise exception 'Use Change password for bidder accounts'; end if;
 -- Authorize the intended target/workspace before any availability response.
 if p_kind='create_client' then
  if not public.is_admin() then raise exception 'Access denied'; end if;
 elsif p_kind='create_bidder' then perform public.require_manager(workspace);
 else
  if not public.can_manage_account(target) then raise exception 'Access denied'; end if;
  if p_kind not in ('reset_password','sign_out_bidder','set_bidder_password') and not exists(select 1 from public.profiles where id=target and role=replace(p_kind,'update_','')) then raise exception 'Account type does not match'; end if;
  select b.workspace_id into workspace from public.bidders b where b.user_id=target;
 end if;
 if exists(select 1 from public.account_operations q where q.status in ('ready','pending') and
   (q.target_id=target or (mail is not null and q.email=mail))) then raise exception 'Resolve the pending account operation first' using errcode='PBA01'; end if;
 if p_kind='create_client' then target:=public.reserve_client_account(mail,v->>'name');
 elsif p_kind='create_bidder' then target:=public.invite_bidder(workspace,mail,v->>'name',(v->>'rate')::integer);
 end if;
 -- Never let an impossible destination email lock an unrelated account. The
 -- generic error reveals no identity/reservation details. Own unchanged email
 -- and this identity's exact provisioning reservation remain valid.
 if mail is not null and (
   exists(select 1 from auth.users where lower(email)=mail and id<>target)
   or exists(select 1 from public.profiles where lower(email)=mail and id<>target)
   or exists(select 1 from public.invitations where email=mail and id<>target)
   or exists(select 1 from public.client_provisions where email=mail and id<>target)
 ) then raise exception 'This email is already in use or reserved'; end if;
 insert into public.account_operations(request_id,actor_id,kind,target_id,workspace_id,email,payload,fingerprint,reservation_transaction,auth_step,password_commitment)
 values(p_request,auth.uid(),p_kind,target,workspace,mail,v-'password_commitment',fingerprint,txid_current(),
  case when p_kind='sign_out_bidder' then 'skipped' when p_kind like 'update_%' and (mail is null or exists(select 1 from public.profiles where id=target and lower(email)=mail)) then 'skipped' else 'ready' end,v->>'password_commitment')
 returning * into o;
 if not public.account_operation_allowed(o,auth.uid()) then raise exception 'Access denied'; end if;
 return public.account_operation_view(o);
end $$;

drop function public.dispatch_account_operation(uuid,uuid);
create or replace function public.dispatch_account_operation(p_request uuid,p_actor uuid,p_password_commitment text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.account_operations; begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 perform pg_advisory_xact_lock(220022);
 select * into o from public.account_operations where request_id=p_request for update;
 if not found or o.actor_id<>p_actor or not public.account_operation_allowed(o,p_actor) then raise exception 'Access denied'; end if;
 if o.status in ('completed','abandoned') or o.auth_step<>'ready' then return public.account_operation_view(o); end if;
 if o.kind='set_bidder_password' and (p_password_commitment is null or o.password_commitment is distinct from p_password_commitment) then raise exception 'Re-enter the original password to resume this request'; end if;
 -- Refresh only this exact still-unconsumed reservation, preserving retry expiry policy.
 if o.kind='create_bidder' then update public.invitations set expires_at=clock_timestamp()+interval '7 days' where id=o.target_id and accepted_at is null; end if;
 update public.account_operations set status='pending',auth_step='dispatched',dispatch_id=gen_random_uuid(),
   lease_until=clock_timestamp()+interval '60 seconds' where request_id=p_request returning * into o;
 return public.account_operation_view(o)||jsonb_build_object('dispatchId',o.dispatch_id);
end $$;
revoke all on function public.dispatch_account_operation(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.dispatch_account_operation(uuid,uuid,text) to service_role;

create or replace function public.accept_account_auth_effect() returns trigger
language plpgsql security definer set search_path='' as $$
declare marker jsonb; o public.account_operations; begin
 marker:=new.raw_app_meta_data->'managed_account_operation';
 if marker is null or (tg_op='UPDATE' and marker is not distinct from old.raw_app_meta_data->'managed_account_operation') then return new; end if;
 perform pg_advisory_xact_lock(220022);
 select * into o from public.account_operations where request_id=(marker->>'request')::uuid for update;
 if not found or o.target_id<>new.id or o.status not in ('ready','pending') or o.auth_step<>'dispatched'
   or o.dispatch_id is distinct from (marker->>'dispatch')::uuid then raise exception 'Account dispatch was fenced'; end if;
 if not public.account_operation_allowed(o,o.actor_id) then raise exception 'Access denied'; end if;
 if o.email is not null and lower(new.email)<>o.email then raise exception 'Account email does not match intent'; end if;
 update public.account_operations set auth_step='accepted',accepted_at=clock_timestamp(),auth_transaction=txid_current(),lease_until=null where request_id=o.request_id;
 if o.kind='set_bidder_password' then perform public.revoke_bidder_sessions(o.target_id); end if;
 return new;
end $$;

create or replace function public.finish_account_operation(p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.account_operations; begin
 perform pg_advisory_xact_lock(220022);
 select * into o from public.account_operations where request_id=p_request for update;
 if not found or o.actor_id<>auth.uid() or not public.account_operation_allowed(o,auth.uid()) then raise exception 'Access denied'; end if;
 if o.status in ('completed','abandoned') or o.auth_step not in ('accepted','skipped') then return public.account_operation_view(o); end if;
 -- Visible together with all mutations/audits, or all roll back. Updating the
 -- receipt first allows legacy trigger guards without a forgeable GUC bypass.
 update public.account_operations set status='completed',completed_at=clock_timestamp(),lease_until=null where request_id=p_request returning * into o;
 case o.kind
 when 'update_bidder' then perform public.update_bidder(o.target_id,o.payload->>'name',(o.payload->>'rate')::integer,(o.payload->>'archived')::boolean);
 when 'update_client' then perform public.update_client(o.target_id,o.payload->>'name',(o.payload->>'archived')::boolean);
 when 'create_client' then
  perform public.review_client(o.target_id,'approved',null);
  perform public.record_account_event(o.target_id,'created');
 when 'create_bidder' then perform public.record_account_event(o.target_id,'created');
 when 'sign_out_bidder' then
  perform public.revoke_bidder_sessions(o.target_id);
  insert into public.account_events(account_id,actor_id,event) values(o.target_id,auth.uid(),'signed_out');
 when 'set_bidder_password' then perform public.record_account_event(o.target_id,'password_reset');
 when 'reset_password' then perform public.record_account_event(o.target_id,'password_reset');
 end case;
 return public.account_operation_view(o);
end $$;

create or replace function public.abandon_account_operation(p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.account_operations; begin
 perform pg_advisory_xact_lock(220022);
 select * into o from public.account_operations where request_id=p_request for update;
 if not found or not public.is_admin() then raise exception 'Access denied'; end if;
 if o.status in ('completed','abandoned') then return public.account_operation_view(o); end if;
 update public.account_operations set status='abandoned',dispatch_id=null,lease_until=null,reconciled_by=auth.uid(),
 disposition=case when auth_step='accepted' then 'Auth change accepted; remaining account changes abandoned by administrator'
 else 'Unaccepted dispatch fenced and operation abandoned by administrator' end
 where request_id=p_request returning * into o;
 if exists(select 1 from public.profiles where id=o.target_id) then
  insert into public.account_events(account_id,actor_id,event,reason) values(o.target_id,auth.uid(),'operation_abandoned',
   o.disposition||'; request='||o.request_id||'; original actor='||o.actor_id);
  if o.auth_step='accepted' then
   insert into public.account_events(account_id,actor_id,event,reason) values(o.target_id,o.actor_id,
    case when o.kind in ('reset_password','set_bidder_password') then 'password_reset' when o.kind like 'create_%' then 'created' else 'email_updated' end,
    'Auth effect accepted; remaining changes abandoned; request='||o.request_id);
  end if;
 end if;
 return public.account_operation_view(o);
end $$;

-- A legacy or self-service password-only Auth write has no changed journal
-- marker. Fence that conflicting effect at commit, while retaining the provider's
-- password-before-metadata ordering within a valid managed transaction.
create or replace function public.guard_account_auth_password_write() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Serialize with begin/dispatch/receipt/reconcile, including a concurrent begin
 -- that has not yet committed its target reservation. Do not precheck unlocked.
 perform pg_advisory_xact_lock(220022);
 if exists (
  select 1 from public.account_operations o
  where o.target_id=new.id and o.status in ('ready','pending')
   and (o.auth_step<>'accepted' or o.auth_transaction is distinct from txid_current()
    or o.kind not in ('reset_password','set_bidder_password','create_client','create_bidder'))
 ) then
  raise exception 'Resolve the pending account operation first' using errcode='PBA01';
 end if;
 return new;
end $$;

