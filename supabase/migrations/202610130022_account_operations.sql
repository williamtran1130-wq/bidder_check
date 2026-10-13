-- Durable managed-account intents. Provider effects and their receipt share the
-- Auth transaction; executor expiry never by itself authorizes replay.
create table public.account_operations (
 request_id uuid primary key, actor_id uuid not null references public.profiles,
 kind text not null check(kind in ('create_client','create_bidder','update_client','update_bidder','reset_password')),
 target_id uuid not null, workspace_id uuid, email text, payload jsonb not null,
 fingerprint text not null, status text not null default 'ready'
   check(status in ('ready','pending','completed','abandoned')),
 auth_step text not null default 'ready' check(auth_step in ('ready','dispatched','accepted','skipped')),
 dispatch_id uuid, lease_until timestamptz, auth_transaction bigint,
 reservation_transaction bigint, accepted_at timestamptz, completed_at timestamptz,
 reconciled_by uuid references public.profiles, disposition text,
 created_at timestamptz not null default clock_timestamp()
);
create unique index account_operations_active_target on public.account_operations(target_id) where status in ('ready','pending');
create unique index account_operations_active_email on public.account_operations(email) where status in ('ready','pending') and email is not null;
alter table public.account_operations enable row level security;
revoke all on public.account_operations from public,anon,authenticated;
grant all on public.account_operations to service_role;

create function public.account_operation_allowed(o public.account_operations,p_actor uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles a where a.id=p_actor and not a.archived and
  (a.role='admin' or (a.approval_status='approved' and
   exists(select 1 from public.workspaces w where w.id=o.workspace_id and w.owner_id=a.id))))
 and case when exists(select 1 from public.profiles p where p.id=o.target_id) then
  exists(select 1 from public.profiles p where p.id=o.target_id and p.role<>'admin' and
   (exists(select 1 from public.profiles a where a.id=p_actor and a.role='admin') or
    (p.role='bidder' and exists(select 1 from public.bidders b join public.workspaces w on w.id=b.workspace_id
      where b.user_id=p.id and w.owner_id=p_actor))))
 else case o.kind when 'create_client' then exists(select 1 from public.client_provisions r
    where r.id=o.target_id and r.email=o.email and r.display_name=o.payload->>'name' and r.consumed_at is null)
   when 'create_bidder' then exists(select 1 from public.invitations r where r.id=o.target_id and r.email=o.email
    and r.workspace_id=o.workspace_id and r.display_name=o.payload->>'name'
    and r.default_rate_cents is not distinct from (o.payload->>'rate')::integer and r.accepted_at is null)
   else false end end
$$;
create function public.account_operation_view(o public.account_operations) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('requestId',o.request_id,'actorId',o.actor_id,'targetId',o.target_id,
 'kind',o.kind,'payload',o.payload,'status',o.status,'authStep',o.auth_step,
 'leaseUntil',o.lease_until,'acceptedAt',o.accepted_at,'disposition',o.disposition,
 'reconciledBy',o.reconciled_by)
$$;
create function public.begin_account_operation(p_request uuid,p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.account_operations; v jsonb; target uuid; workspace uuid; mail text; fingerprint text;
begin
 if auth.uid() is null then raise exception 'Access denied'; end if;
 if p_request is null then raise exception 'A request id is required'; end if;
 if p_kind not in ('create_client','create_bidder','update_client','update_bidder','reset_password') or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid account operation'; end if;
 mail:=nullif(lower(trim(p_payload->>'email')),'');
 v:=case when p_kind='reset_password' then jsonb_build_object('target',(p_payload->>'target')::uuid)
 else jsonb_build_object('name',case when p_kind='create_bidder' then trim(p_payload->>'name') else left(trim(p_payload->>'name'),100) end,'email',mail) end;
 -- Only normalized, fingerprinted content may reserve an email. In particular,
 -- an extra email field on a password reset has no account-management effect.
 mail:=v->>'email';
 if p_kind<>'reset_password' and (nullif(v->>'name','') is null or (mail is not null and mail !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')) then raise exception 'Valid name and email required'; end if;
 if p_kind like 'create_%' and mail is null then raise exception 'Valid name and email required'; end if;
 if p_kind like 'update_%' then v:=v||jsonb_build_object('target',(p_payload->>'target')::uuid,'archived',coalesce((p_payload->>'archived')::boolean,false)); end if;
 if p_kind in ('create_bidder','update_bidder') then
  if (p_payload->>'rate')::integer not between 0 and 100000000 then raise exception 'Rate is invalid'; end if;
  v:=v||jsonb_build_object('rate',(p_payload->>'rate')::integer);
 end if;
 if p_kind='create_bidder' then v:=v||jsonb_build_object('workspace',(p_payload->>'workspace')::uuid); end if;
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
 -- Authorize the intended target/workspace before any availability response.
 if p_kind='create_client' then
  if not public.is_admin() then raise exception 'Access denied'; end if;
 elsif p_kind='create_bidder' then perform public.require_manager(workspace);
 else
  if not public.can_manage_account(target) then raise exception 'Access denied'; end if;
  if p_kind<>'reset_password' and not exists(select 1 from public.profiles where id=target and role=replace(p_kind,'update_','')) then raise exception 'Account type does not match'; end if;
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
 insert into public.account_operations(request_id,actor_id,kind,target_id,workspace_id,email,payload,fingerprint,reservation_transaction,auth_step)
 values(p_request,auth.uid(),p_kind,target,workspace,mail,v,fingerprint,txid_current(),
  case when p_kind like 'update_%' and (mail is null or exists(select 1 from public.profiles where id=target and lower(email)=mail)) then 'skipped' else 'ready' end)
 returning * into o;
 if not public.account_operation_allowed(o,auth.uid()) then raise exception 'Access denied'; end if;
 return public.account_operation_view(o);
end $$;
create function public.account_operation_request_exists(p_request uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.profiles where id=auth.uid() and not archived
   and (role='admin' or approval_status='approved')) then raise exception 'Access denied'; end if;
 -- Wait for any in-flight begin transaction before proving absence. Expose
 -- only this actor's identity binding, never another actor's request or target.
 perform pg_advisory_xact_lock(220022);
 return exists(select 1 from public.account_operations where request_id=p_request and actor_id=auth.uid());
end $$;
create function public.account_operation_status(p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.account_operations; begin
 select * into o from public.account_operations where request_id=p_request;
 if not found or not public.account_operation_allowed(o,auth.uid()) then raise exception 'Access denied'; end if;
 return public.account_operation_view(o);
end $$;
create function public.list_account_operations() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(public.account_operation_view(o) order by o.created_at),'[]'::jsonb)
 from public.account_operations o where o.status in ('ready','pending') and public.account_operation_allowed(o,auth.uid())
$$;
create function public.dispatch_account_operation(p_request uuid,p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.account_operations; begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 perform pg_advisory_xact_lock(220022);
 select * into o from public.account_operations where request_id=p_request for update;
 if not found or o.actor_id<>p_actor or not public.account_operation_allowed(o,p_actor) then raise exception 'Access denied'; end if;
 if o.status in ('completed','abandoned') or o.auth_step<>'ready' then return public.account_operation_view(o); end if;
 -- Refresh only this exact still-unconsumed reservation, preserving retry expiry policy.
 if o.kind='create_bidder' then update public.invitations set expires_at=clock_timestamp()+interval '7 days' where id=o.target_id and accepted_at is null; end if;
 update public.account_operations set status='pending',auth_step='dispatched',dispatch_id=gen_random_uuid(),
   lease_until=clock_timestamp()+interval '60 seconds' where request_id=p_request returning * into o;
 return public.account_operation_view(o)||jsonb_build_object('dispatchId',o.dispatch_id);
end $$;

-- Admin Auth changes update password/email before app metadata, all within the
-- same provider transaction. Only a CHANGED server-owned marker is a receipt.
-- Existing markers on login, self-service updates and unrelated metadata are inert.
create function public.accept_account_auth_effect() returns trigger
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
 return new;
end $$;
create trigger zz_account_auth_receipt after insert or update of raw_app_meta_data on auth.users
 for each row execute function public.accept_account_auth_effect();

create function public.reconcile_account_operation(p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.account_operations; begin
 perform pg_advisory_xact_lock(220022);
 select * into o from public.account_operations where request_id=p_request for update;
 if not found or not public.account_operation_allowed(o,auth.uid()) then raise exception 'Access denied'; end if;
 if o.auth_step='dispatched' and o.status='pending' and o.lease_until<=clock_timestamp() then
  -- The row lock serializes against the receipt trigger. Invalidate BEFORE
  -- allowing replay: a late old provider transaction must now roll back.
  update public.account_operations set auth_step='ready',status='ready',dispatch_id=null,lease_until=null,
   reconciled_by=auth.uid(),disposition='Prior dispatch fenced; no committed Auth receipt'
   where request_id=p_request returning * into o;
 end if;
 return public.account_operation_view(o);
end $$;
create function public.finish_account_operation(p_request uuid) returns jsonb
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
 when 'reset_password' then perform public.record_account_event(o.target_id,'password_reset');
 end case;
 return public.account_operation_view(o);
end $$;
create function public.abandon_account_operation(p_request uuid) returns jsonb
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
    case when o.kind='reset_password' then 'password_reset' when o.kind like 'create_%' then 'created' else 'email_updated' end,
    'Auth effect accepted; remaining changes abandoned; request='||o.request_id);
  end if;
 end if;
 return public.account_operation_view(o);
end $$;

-- Deferred guards accommodate Auth's email-sync/provisioning BEFORE its metadata
-- write, then require the receipt's actual transaction ID. Existing public RPC
-- signatures stay intact, and clients cannot mint the transaction-bound bypass.
create function public.guard_account_operation_write() returns trigger
language plpgsql security definer set search_path='' as $$
declare rowdata jsonb; prior jsonb; target uuid; mail text; o public.account_operations; begin
 rowdata:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 prior:=case when tg_op='UPDATE' then to_jsonb(old) else '{}'::jsonb end;
 if tg_table_name='profiles' and tg_op='UPDATE' and
  (rowdata-'updated_at')=(prior-'updated_at') then return new; end if;
 target:=case tg_table_name when 'bidders' then (rowdata->>'user_id')::uuid when 'account_events' then (rowdata->>'account_id')::uuid else (rowdata->>'id')::uuid end;
 mail:=lower(rowdata->>'email');
 perform pg_advisory_xact_lock(220022);
 for o in select * from public.account_operations where status in ('ready','pending') and
  (target_id=target or (mail is not null and email=mail)) loop
  if o.auth_transaction=txid_current() and o.auth_step='accepted' then
   if tg_op='INSERT' and o.kind like 'create_%' and tg_table_name in ('profiles','bidders') then continue; end if;
   if tg_table_name='profiles' and tg_op='UPDATE' and
     (rowdata-'email'-'updated_at')=(prior-'email'-'updated_at') and mail=o.email then continue; end if;
   if tg_table_name='invitations' and tg_op='UPDATE' and
     (rowdata-'email'-'accepted_at')=(prior-'email'-'accepted_at') then continue; end if;
   if tg_table_name='client_provisions' and tg_op='UPDATE' and
     (rowdata-'consumed_at')=(prior-'consumed_at') then continue; end if;
  end if;
  if tg_table_name in ('invitations','client_provisions') and o.reservation_transaction=txid_current() then continue; end if;
  if tg_table_name='invitations' and tg_op='UPDATE' and (rowdata-'expires_at')=(prior-'expires_at') then continue; end if;
  raise exception 'Resolve the pending account operation first' using errcode='PBA01';
 end loop;
 return case when tg_op='DELETE' then old else new end;
end $$;
create constraint trigger account_profile_guard after insert or update or delete on public.profiles deferrable initially deferred for each row execute function public.guard_account_operation_write();
create constraint trigger account_bidder_guard after insert or update or delete on public.bidders deferrable initially deferred for each row execute function public.guard_account_operation_write();
create constraint trigger account_invitation_guard after insert or update or delete on public.invitations deferrable initially deferred for each row execute function public.guard_account_operation_write();
create constraint trigger account_provision_guard after insert or update or delete on public.client_provisions deferrable initially deferred for each row execute function public.guard_account_operation_write();
create constraint trigger account_event_guard after insert or update or delete on public.account_events deferrable initially deferred for each row execute function public.guard_account_operation_write();

revoke all on function public.account_operation_allowed(public.account_operations,uuid),public.account_operation_view(public.account_operations),public.accept_account_auth_effect(),public.guard_account_operation_write(),public.begin_account_operation(uuid,text,jsonb),public.account_operation_request_exists(uuid),public.account_operation_status(uuid),public.list_account_operations(),public.dispatch_account_operation(uuid,uuid),public.reconcile_account_operation(uuid),public.finish_account_operation(uuid),public.abandon_account_operation(uuid) from public,anon,authenticated;
grant execute on function public.begin_account_operation(uuid,text,jsonb),public.account_operation_request_exists(uuid),public.account_operation_status(uuid),public.list_account_operations(),public.reconcile_account_operation(uuid),public.finish_account_operation(uuid),public.abandon_account_operation(uuid) to authenticated;
grant execute on function public.dispatch_account_operation(uuid,uuid) to service_role;
