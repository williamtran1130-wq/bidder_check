-- A client's complete aggregate snapshot. No role can read the raw mailbox blob
-- through the Data API; the report projects the caller's live assignment scope.
create table public.mail_insights_state (
 client_id uuid primary key references public.profiles(id) on delete cascade,
 workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
 last_revision bigint not null default 0 check(last_revision between 0 and 9007199254740991),
 original_hash text,
 generated_at timestamptz,
 received_at timestamptz,
 mailboxes jsonb not null default '[]'::jsonb
);
alter table public.mail_insights_state enable row level security;
revoke all on public.mail_insights_state from public,anon,authenticated;
grant all on public.mail_insights_state to service_role;

create function private.mail_insights_keys(p_value jsonb,p_keys text[]) returns boolean
language sql immutable set search_path='' as $$
 select case when jsonb_typeof(p_value)='object' then
  p_value ?& p_keys and not exists(select 1 from jsonb_object_keys(p_value) k where not(k=any(p_keys)))
 else false end
$$;

create function public.ingest_mail_insights(p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=auth.uid(); w uuid; m jsonb; r jsonb; rev bigint; hashed text;
 prior public.mail_insights_state; seen_emails text[]:='{}'; seen_rows text[]; k text;
 day date; today date:=(current_timestamp at time zone 'America/Chicago')::date;
 total numeric:=0;
begin
 select ws.id into w from public.workspaces ws join public.profiles p on p.id=ws.owner_id
 where p.id=actor and p.role='client' and not p.archived and p.approval_status='approved';
 if w is null or p_snapshot->>'client_id' is distinct from actor::text then
  raise exception 'Access denied' using errcode='42501';
 end if;
 begin
  if octet_length(p_snapshot::text)>2097152 or not private.mail_insights_keys(p_snapshot,
   array['schema_version','client_id','revision','generated_at','timezone','mailboxes'])
   or p_snapshot->'schema_version'<>'1'::jsonb or p_snapshot->>'timezone'<>'America/Chicago'
   or jsonb_typeof(p_snapshot->'mailboxes')<>'array' or jsonb_array_length(p_snapshot->'mailboxes')>500
   or jsonb_typeof(p_snapshot->'revision')<>'number'
   or (p_snapshot->>'revision')!~'^[0-9]+$'
   or (p_snapshot->>'revision')::numeric not between 1 and 9007199254740991
   or jsonb_typeof(p_snapshot->'generated_at')<>'string'
   or (p_snapshot->>'generated_at')!~'^\d{4}-\d{2}-\d{2}T.*(Z|\+00:00)$'
  then raise exception 'Invalid snapshot'; end if;
  perform (p_snapshot->>'generated_at')::timestamptz;
  rev:=(p_snapshot->>'revision')::bigint;
 exception when others then
  raise exception 'Invalid snapshot' using errcode='22023';
 end;
 hashed:=encode(sha256(convert_to(p_snapshot::text,'UTF8')),'hex');
 insert into public.mail_insights_state(client_id,workspace_id) values(actor,w) on conflict(client_id) do nothing;
 select * into prior from public.mail_insights_state where client_id=actor for update;
 -- Ledger checks precede current-day validation: an old accepted payload remains
 -- idempotent after its rows age out, without restoring data or freshness.
 if rev=prior.last_revision and hashed=prior.original_hash then
  return jsonb_build_object('ok',true,'revision',rev,'received_at',prior.received_at,'unchanged',true);
 end if;
 if rev<=prior.last_revision then
  return jsonb_build_object('error','A newer or conflicting snapshot already exists.','code','revision_conflict','last_revision',prior.last_revision);
 end if;
 begin
  for m in select value from jsonb_array_elements(p_snapshot->'mailboxes') loop
   if not private.mail_insights_keys(m,array['email','account_label','collected_at','coverage_start','rows'])
    or jsonb_typeof(m->'email')<>'string' or length(m->>'email')>320
    or (m->>'email')!~'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    or m->>'email'<>lower(trim(m->>'email')) or (m->>'email')=any(seen_emails)
    or jsonb_typeof(m->'account_label')<>'string' or length(m->>'account_label')>200
    or jsonb_typeof(m->'rows')<>'array' or jsonb_array_length(m->'rows')>50000
   then raise exception 'Invalid snapshot'; end if;
   seen_emails:=array_append(seen_emails,m->>'email');
   if m->'collected_at'<>'null'::jsonb then
    if jsonb_typeof(m->'collected_at')<>'string' or (m->>'collected_at')!~'^\d{4}-\d{2}-\d{2}T.*(Z|\+00:00)$' then raise exception 'Invalid snapshot'; end if;
    perform (m->>'collected_at')::timestamptz;
   end if;
   if m->'coverage_start'<>'null'::jsonb then
    if jsonb_typeof(m->'coverage_start')<>'string' or (m->>'coverage_start')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid snapshot'; end if;
    perform (m->>'coverage_start')::date;
   end if;
   seen_rows:='{}';
   for r in select value from jsonb_array_elements(m->'rows') loop
    if not private.mail_insights_keys(r,array['date','category','handled','action_required','retryable','count'])
     or jsonb_typeof(r->'date')<>'string' or (r->>'date')!~'^\d{4}-\d{2}-\d{2}$'
     or jsonb_typeof(r->'category')<>'string' or r->>'category' not in
      ('application_ack','interview_invite','assessment','offer','info_request','recruiter_outreach','rejection','job_alert','other','unclassified')
     or jsonb_typeof(r->'handled')<>'boolean' or jsonb_typeof(r->'action_required')<>'boolean'
     or jsonb_typeof(r->'retryable')<>'boolean' or jsonb_typeof(r->'count')<>'number'
     or (r->>'count')!~'^[0-9]+$' or (r->>'count')::numeric not between 0 and 1000000000
    then raise exception 'Invalid snapshot'; end if;
    day:=(r->>'date')::date;
    if day<today-89 or day>today then raise exception 'Invalid snapshot'; end if;
    k:=jsonb_build_array(r->>'date',r->>'category',r->'handled',r->'action_required',r->'retryable')::text;
    if k=any(seen_rows) then raise exception 'Invalid snapshot'; end if;
    seen_rows:=array_append(seen_rows,k);
    total:=total+(r->>'count')::numeric;
    if total>9007199254740991 then raise exception 'Invalid snapshot'; end if;
   end loop;
  end loop;
 exception when others then
  raise exception 'Invalid snapshot' using errcode='22023';
 end;
 update public.mail_insights_state set last_revision=rev,original_hash=hashed,
  generated_at=(p_snapshot->>'generated_at')::timestamptz,received_at=clock_timestamp(),mailboxes=p_snapshot->'mailboxes'
 where client_id=actor returning * into prior;
 return jsonb_build_object('ok',true,'revision',rev,'received_at',prior.received_at,'unchanged',false);
end $$;
revoke all on function public.ingest_mail_insights(jsonb) from public,anon;
grant execute on function public.ingest_mail_insights(jsonb) to authenticated;

create function public.mail_insights_connection() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 select jsonb_build_object('client_id',p.id,'workspace_id',w.id,'display_name',p.display_name,'email',p.email,'last_revision',coalesce(s.last_revision,0)) into result
 from public.profiles p join public.workspaces w on w.owner_id=p.id left join public.mail_insights_state s on s.client_id=p.id
 where p.id=auth.uid() and p.role='client' and not p.archived and p.approval_status='approved';
 if result is null then raise exception 'Access denied' using errcode='42501'; end if;
 return result;
end $$;
revoke all on function public.mail_insights_connection() from public,anon;
grant execute on function public.mail_insights_connection() to authenticated;

create function public.mail_insights_report(p_from date,p_to date,p_workspace uuid,p_bidder uuid,p_profile uuid,p_email text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare role_name text; today date:=(current_timestamp at time zone 'America/Chicago')::date;
 lo date:=greatest(coalesce(p_from,today-89),today-89); hi date:=least(coalesce(p_to,today),today);
 result jsonb;
begin
 role_name:=private.validate_report(p_from,p_to,p_workspace,p_bidder,p_profile,'assignment',false);
 if role_name='admin' and p_workspace is null then raise exception 'Choose a workspace to view email insights.' using errcode='22023'; end if;
 with ws as materialized (
  select w.id,w.owner_id from public.workspaces w
  where (p_workspace is null or w.id=p_workspace) and (public.manages(w.id) or exists(
   select 1 from public.bidders b where b.workspace_id=w.id and b.user_id=auth.uid() and public.can_read(w.id,b.user_id)))
 ), assignments as materialized (
  select r.id,r.workspace_id,r.bidder_id,bp.display_name bidder_name,r.profile_id,cp.identifier profile_label,
   lower(trim(r.email)) email,(r.archived or cp.archived or b.archived or bp.archived) archived
  from public.resumes r join ws on ws.id=r.workspace_id join public.candidate_profiles cp on cp.id=r.profile_id
  join public.bidders b on b.user_id=r.bidder_id join public.profiles bp on bp.id=b.user_id
  where public.can_read(r.workspace_id,r.bidder_id)
   and (role_name<>'bidder' or (r.bidder_id=auth.uid() and not r.archived and not cp.archived and not b.archived and not bp.archived))
   and (p_bidder is null or r.bidder_id=p_bidder) and (p_profile is null or r.profile_id=p_profile)
   and (p_email is null or lower(trim(r.email))=lower(trim(p_email)))
 ), scoped as materialized (
  select s.* from public.mail_insights_state s join ws on ws.id=s.workspace_id
 ), mail as materialized (
  select m.value mailbox from scoped s cross join lateral jsonb_array_elements(s.mailboxes) m
  where (p_email is null or m.value->>'email'=lower(trim(p_email)))
  and ((role_name<>'bidder' and p_bidder is null and p_profile is null) or exists(
   select 1 from assignments a where a.workspace_id=s.workspace_id and a.email=m.value->>'email'))
 ), projected_mail as (
  select (mailbox-'rows')||jsonb_build_object('rows',coalesce((select jsonb_agg(r.value) from jsonb_array_elements(mailbox->'rows') r
    where (r.value->>'date')::date between lo and hi),'[]'::jsonb)) mailbox from mail
 ), bid_rows as (
  select e.day date,a.workspace_id,e.bidder_id,e.profile_id,e.resume_id assignment_id,a.email,
   sum(case when e.metric='found' then e.n else 0 end) found,
   sum(case when e.metric='applied_activity' then e.n else 0 end) applied
  from private.dashboard_report_events(lo,hi,p_workspace,p_bidder,p_profile) e join assignments a on a.id=e.resume_id
  where lo<=hi and e.metric in ('found','applied_activity')
  group by e.day,a.workspace_id,e.bidder_id,e.profile_id,e.resume_id,a.email
 )
 select jsonb_build_object(
  'mailboxes',coalesce((select jsonb_agg(mailbox order by mailbox->>'email') from projected_mail),'[]'::jsonb),
  'assignments',coalesce((select jsonb_agg(to_jsonb(a) order by a.email,a.id) from assignments a),'[]'::jsonb),
  'bid_rows',coalesce((select jsonb_agg(to_jsonb(b) order by b.date,b.assignment_id) from bid_rows b),'[]'::jsonb),
  'received_at',(select max(s.received_at) from scoped s where role_name<>'bidder' or exists(select 1 from mail)),
  'generated_at',(select max(s.generated_at) from scoped s where role_name<>'bidder' or exists(select 1 from mail)),
  'range',jsonb_build_object('from',case when lo<=hi then lo else coalesce(p_from,lo) end,'to',case when lo<=hi then hi else coalesce(p_to,hi) end,
   'clipped',p_from is null or p_to is null or p_from<today-89 or p_to>today,'empty',lo>hi),
  'status',case when exists(select 1 from scoped where last_revision>0) and (role_name<>'bidder' or exists(select 1 from mail)) then 'ready' else 'not_synced' end
 ) into result;
 return result;
end $$;
revoke all on function public.mail_insights_report(date,date,uuid,uuid,uuid,text) from public,anon;
grant execute on function public.mail_insights_report(date,date,uuid,uuid,uuid,text) to authenticated;

-- Preserve revision/hash timestamps while physically dropping expired cube rows.
create function public.prune_mail_insights(p_limit integer default 100) returns integer
language plpgsql security definer set search_path='' as $$
declare changed integer; cutoff text:=((current_timestamp at time zone 'America/Chicago')::date-89)::text;
begin
 if p_limit not between 1 and 1000 then raise exception 'Invalid limit'; end if;
 with batch as (select client_id from public.mail_insights_state s where exists(
  select 1 from jsonb_array_elements(s.mailboxes) m cross join lateral jsonb_array_elements(m->'rows') r where r->>'date'<cutoff
 ) limit p_limit for update skip locked)
 update public.mail_insights_state s set mailboxes=(select coalesce(jsonb_agg((m-'rows')||jsonb_build_object('rows',
  (select coalesce(jsonb_agg(r),'[]'::jsonb) from jsonb_array_elements(m->'rows') r where r->>'date'>=cutoff))),'[]'::jsonb)
  from jsonb_array_elements(s.mailboxes) m)
 where s.client_id in(select client_id from batch);
 get diagnostics changed=row_count; return changed;
end $$;
revoke all on function public.prune_mail_insights(integer) from public,anon,authenticated;
grant execute on function public.prune_mail_insights(integer) to service_role;

-- Preserve the existing dashboard contract while adding current-assignment email scope.
create function private.dashboard_email_report(p_from date,p_to date,p_workspace uuid,p_bidder uuid,p_profile uuid,p_email text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
#variable_conflict use_column
declare role_name text; report jsonb;
begin
 role_name=private.validate_report(p_from,p_to,p_workspace,p_bidder,p_profile,'profile',false);
 with events as materialized (select e.* from private.dashboard_report_events(p_from,p_to,p_workspace,p_bidder,p_profile) e join public.resumes r on r.id=e.resume_id where lower(trim(r.email))=lower(trim(p_email))),
 range as (select coalesce(p_from,min(day),(current_timestamp at time zone 'America/Chicago')::date) lo,coalesce(p_to,(current_timestamp at time zone 'America/Chicago')::date) hi from events),
 sizing as (select *,case when hi-lo+1<=90 then 'day'
  when (date_trunc('week',hi::timestamp)::date-date_trunc('week',lo::timestamp)::date)/7+1<=104 then 'week'
  when (extract(year from hi)-extract(year from lo))*12+extract(month from hi)-extract(month from lo)+1<=120 then 'month' else 'year' end unit from range),
 config as (select *,case when unit='year' then ceil((extract(year from hi)-extract(year from lo)+1)/120)::integer else 1 end width from sizing),
 aligned as (select *,date_trunc(unit,lo::timestamp)::date origin,make_interval(days=>case unit when 'day' then 1 when 'week' then 7 else 0 end,months=>case unit when 'month' then 1 else 0 end,years=>case unit when 'year' then width else 0 end) step from config),
 daily as (select day,coalesce(sum(n) filter(where metric='found'),0) found,coalesce(sum(found_applied) filter(where metric='found'),0) found_applied,coalesce(sum(n) filter(where metric='applied_activity'),0) applied from events group by day),
 aggregated as (select case a.unit when 'year' then make_date(extract(year from a.origin)::integer+((extract(year from d.day)::integer-extract(year from a.origin)::integer)/a.width)*a.width,1,1) else date_trunc(a.unit,d.day::timestamp)::date end bucket,sum(d.found) found,sum(d.found_applied) found_applied,sum(d.applied) applied from daily d cross join aligned a group by 1),
 buckets as (select greatest(g::date,a.lo) lo,least((g+a.step)::date-1,a.hi) hi,coalesce(t.found,0) found,coalesce(t.found_applied,0) found_applied,coalesce(t.applied,0) applied from aligned a cross join lateral generate_series(a.origin::timestamp,a.hi::timestamp,a.step) g left join aggregated t on t.bucket=g::date),
 comparisons as (
  select 'bidders' kind,bidder_id id,sum(n) found,sum(found_applied) found_applied,
   sum(remote_found) remote_found,sum(remote_applied) remote_applied,
   sum(onsite_hybrid_found) onsite_hybrid_found,sum(onsite_hybrid_applied) onsite_hybrid_applied,
   sum(unspecified_found) unspecified_found,sum(unspecified_applied) unspecified_applied
  from events where metric='found' group by bidder_id
  union all select 'profiles',profile_id,sum(n),sum(found_applied),
   sum(remote_found),sum(remote_applied),
   sum(onsite_hybrid_found),sum(onsite_hybrid_applied),
   sum(unspecified_found),sum(unspecified_applied)
  from events where metric='found' group by profile_id),
 labels as (select c.*,case c.kind when 'bidders' then coalesce(bp.display_name,'Bidder') else coalesce(cp.identifier,'Profile') end label,
  jsonb_build_object('remote',jsonb_build_object('found',remote_found,'foundApplied',remote_applied),'onsiteHybrid',jsonb_build_object('found',onsite_hybrid_found,'foundApplied',onsite_hybrid_applied),'unspecified',jsonb_build_object('found',unspecified_found,'foundApplied',unspecified_applied)) arrangements
 from comparisons c left join public.profiles bp on c.kind='bidders' and bp.id=c.id left join public.candidate_profiles cp on c.kind='profiles' and cp.id=c.id)
 select jsonb_build_object(
 'range',(select jsonb_build_object('from',lo,'to',hi,'bucketUnit',unit,'bucketSize',width) from config),
 'totals',(select jsonb_build_object('found',coalesce(sum(n) filter(where metric='found'),0),'foundApplied',coalesce(sum(found_applied) filter(where metric='found'),0),'appliedActivity',coalesce(sum(n) filter(where metric='applied_activity'),0),'trackedApplications',coalesce(sum(tracked) filter(where metric='earning'),0),'trackedInterviews',coalesce(sum(interviews) filter(where metric='earning'),0)) from events),
 'series',coalesce((select jsonb_agg(jsonb_build_object('from',lo,'to',hi,'found',found,'foundApplied',found_applied,'applied',applied) order by lo) from buckets),'[]'::jsonb),
 'comparisons',jsonb_build_object('bidders',coalesce((select jsonb_agg(jsonb_build_object('id',id,'label',label,'found',found,'foundApplied',found_applied,'arrangements',arrangements) order by found_applied desc,found desc,id) from labels where kind='bidders'),'[]'::jsonb),'profiles',coalesce((select jsonb_agg(jsonb_build_object('id',id,'label',label,'found',found,'foundApplied',found_applied,'arrangements',arrangements) order by found_applied desc,found desc,id) from labels where kind='profiles'),'[]'::jsonb)))
 || case when role_name='bidder' then '{}'::jsonb else jsonb_build_object('financial',(select jsonb_build_object('earningsCents',coalesce(sum(cents),0),'earningsCount',coalesce(sum(n),0)) from events where metric='earning')) end into report;
 return report;
end $$;

revoke all on function private.dashboard_email_report(date,date,uuid,uuid,uuid,text) from public,anon,authenticated;
create function public.dashboard_email_performance(p_from date,p_to date,p_workspace uuid,p_bidder uuid,p_profile uuid,p_email text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_email is null or length(p_email)>320 then raise exception 'Invalid email filter' using errcode='22023'; end if;
 return private.dashboard_email_report(p_from,p_to,p_workspace,p_bidder,p_profile,p_email);
end $$;
revoke all on function public.dashboard_email_performance(date,date,uuid,uuid,uuid,text) from public,anon;
grant execute on function public.dashboard_email_performance(date,date,uuid,uuid,uuid,text) to authenticated;
