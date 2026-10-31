-- Private, transactionally maintained summaries. Never expose stored financial
-- counters or mailbox rows directly to authenticated users.
create table private.bid_report_daily (
 workspace_id uuid not null, bidder_id uuid not null, resume_id uuid not null,
 day date not null, metric text not null,
 n bigint not null, found_applied bigint not null, tracked bigint not null,
 interviews bigint not null, cents bigint not null,
 remote_found bigint not null, remote_applied bigint not null,
 onsite_hybrid_found bigint not null, onsite_hybrid_applied bigint not null,
 unspecified_found bigint not null, unspecified_applied bigint not null,
 primary key(workspace_id,bidder_id,resume_id,day,metric)
);
create index bid_report_daily_day on private.bid_report_daily(day,workspace_id,bidder_id);
revoke all on private.bid_report_daily from public,anon,authenticated;

create function private.bid_report_contributions(b public.bids)
returns table(workspace_id uuid,bidder_id uuid,resume_id uuid,day date,metric text,
 n bigint,found_applied bigint,tracked bigint,interviews bigint,cents bigint,
 remote_found bigint,remote_applied bigint,onsite_hybrid_found bigint,onsite_hybrid_applied bigint,unspecified_found bigint,unspecified_applied bigint)
language sql immutable as $$
 select b.workspace_id,b.bidder_id,b.resume_id,(b.found_at at time zone 'America/Chicago')::date,'found',
 1::bigint,b.applied::int::bigint,0::bigint,0::bigint,0::bigint,
 (b.arrangement='remote')::int::bigint,(b.arrangement='remote' and b.applied)::int::bigint,
 (b.arrangement in ('onsite','hybrid'))::int::bigint,(b.arrangement in ('onsite','hybrid') and b.applied)::int::bigint,0::bigint,0::bigint
 where b.deleted_at is null
 union all select b.workspace_id,b.bidder_id,b.resume_id,(b.applied_at at time zone 'America/Chicago')::date,'applied_activity',1,0,0,0,0,0,0,0,0,0,0
 where b.deleted_at is null and b.applied and b.applied_at is not null
 union all select b.workspace_id,b.bidder_id,b.resume_id,(b.first_applied_at at time zone 'America/Chicago')::date,'earning',1,0,1,b.interview_scheduled::int::bigint,coalesce(b.rate_cents,0)::bigint,0,0,0,0,0,0
 where b.deleted_at is null and b.applied and b.first_applied_at is not null
$$;
revoke all on function private.bid_report_contributions(public.bids) from public,anon,authenticated;

-- Group entire statement transitions before touching a counter; use a stable
-- key order to keep bulk imports and concurrent updates from lock inversion.
create function private.maintain_bid_report_daily_insert() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into private.bid_report_daily as d
 select workspace_id,bidder_id,resume_id,day,metric,
 sum(n*sign),sum(found_applied*sign),sum(tracked*sign),sum(interviews*sign),sum(cents*sign),
 sum(remote_found*sign),sum(remote_applied*sign),sum(onsite_hybrid_found*sign),sum(onsite_hybrid_applied*sign),sum(unspecified_found*sign),sum(unspecified_applied*sign)
 from (select c.*,1 as sign from new_bids b cross join lateral private.bid_report_contributions(b) c) delta group by workspace_id,bidder_id,resume_id,day,metric
 having sum(n*sign)<>0 or sum(found_applied*sign)<>0 or sum(tracked*sign)<>0 or sum(interviews*sign)<>0 or sum(cents*sign)<>0
 or sum(remote_found*sign)<>0 or sum(remote_applied*sign)<>0 or sum(onsite_hybrid_found*sign)<>0 or sum(onsite_hybrid_applied*sign)<>0 or sum(unspecified_found*sign)<>0 or sum(unspecified_applied*sign)<>0
 order by workspace_id,bidder_id,resume_id,day,metric
 on conflict(workspace_id,bidder_id,resume_id,day,metric) do update set
 n=d.n+excluded.n,found_applied=d.found_applied+excluded.found_applied,tracked=d.tracked+excluded.tracked,
 interviews=d.interviews+excluded.interviews,cents=d.cents+excluded.cents,
 remote_found=d.remote_found+excluded.remote_found,remote_applied=d.remote_applied+excluded.remote_applied,
 onsite_hybrid_found=d.onsite_hybrid_found+excluded.onsite_hybrid_found,onsite_hybrid_applied=d.onsite_hybrid_applied+excluded.onsite_hybrid_applied,
 unspecified_found=d.unspecified_found+excluded.unspecified_found,unspecified_applied=d.unspecified_applied+excluded.unspecified_applied;

 return null;
end $$;
revoke all on function private.maintain_bid_report_daily_insert() from public,anon,authenticated;
create function private.maintain_bid_report_daily_delete() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into private.bid_report_daily as d
 select workspace_id,bidder_id,resume_id,day,metric,
 sum(n*sign),sum(found_applied*sign),sum(tracked*sign),sum(interviews*sign),sum(cents*sign),
 sum(remote_found*sign),sum(remote_applied*sign),sum(onsite_hybrid_found*sign),sum(onsite_hybrid_applied*sign),sum(unspecified_found*sign),sum(unspecified_applied*sign)
 from (select c.*,-1 as sign from old_bids b cross join lateral private.bid_report_contributions(b) c) delta group by workspace_id,bidder_id,resume_id,day,metric
 having sum(n*sign)<>0 or sum(found_applied*sign)<>0 or sum(tracked*sign)<>0 or sum(interviews*sign)<>0 or sum(cents*sign)<>0
 or sum(remote_found*sign)<>0 or sum(remote_applied*sign)<>0 or sum(onsite_hybrid_found*sign)<>0 or sum(onsite_hybrid_applied*sign)<>0 or sum(unspecified_found*sign)<>0 or sum(unspecified_applied*sign)<>0
 order by workspace_id,bidder_id,resume_id,day,metric
 on conflict(workspace_id,bidder_id,resume_id,day,metric) do update set
 n=d.n+excluded.n,found_applied=d.found_applied+excluded.found_applied,tracked=d.tracked+excluded.tracked,
 interviews=d.interviews+excluded.interviews,cents=d.cents+excluded.cents,
 remote_found=d.remote_found+excluded.remote_found,remote_applied=d.remote_applied+excluded.remote_applied,
 onsite_hybrid_found=d.onsite_hybrid_found+excluded.onsite_hybrid_found,onsite_hybrid_applied=d.onsite_hybrid_applied+excluded.onsite_hybrid_applied,
 unspecified_found=d.unspecified_found+excluded.unspecified_found,unspecified_applied=d.unspecified_applied+excluded.unspecified_applied;
 delete from private.bid_report_daily d using (select c.*,-1 as sign from old_bids b cross join lateral private.bid_report_contributions(b) c) delta
 where (d.workspace_id,d.bidder_id,d.resume_id,d.day,d.metric)=(delta.workspace_id,delta.bidder_id,delta.resume_id,delta.day,delta.metric) and d.n=0;
 return null;
end $$;
revoke all on function private.maintain_bid_report_daily_delete() from public,anon,authenticated;
create function private.maintain_bid_report_daily_update() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into private.bid_report_daily as d
 select workspace_id,bidder_id,resume_id,day,metric,
 sum(n*sign),sum(found_applied*sign),sum(tracked*sign),sum(interviews*sign),sum(cents*sign),
 sum(remote_found*sign),sum(remote_applied*sign),sum(onsite_hybrid_found*sign),sum(onsite_hybrid_applied*sign),sum(unspecified_found*sign),sum(unspecified_applied*sign)
 from (select c.*,1 as sign from new_bids b cross join lateral private.bid_report_contributions(b) c union all select c.*,-1 as sign from old_bids b cross join lateral private.bid_report_contributions(b) c) delta group by workspace_id,bidder_id,resume_id,day,metric
 having sum(n*sign)<>0 or sum(found_applied*sign)<>0 or sum(tracked*sign)<>0 or sum(interviews*sign)<>0 or sum(cents*sign)<>0
 or sum(remote_found*sign)<>0 or sum(remote_applied*sign)<>0 or sum(onsite_hybrid_found*sign)<>0 or sum(onsite_hybrid_applied*sign)<>0 or sum(unspecified_found*sign)<>0 or sum(unspecified_applied*sign)<>0
 order by workspace_id,bidder_id,resume_id,day,metric
 on conflict(workspace_id,bidder_id,resume_id,day,metric) do update set
 n=d.n+excluded.n,found_applied=d.found_applied+excluded.found_applied,tracked=d.tracked+excluded.tracked,
 interviews=d.interviews+excluded.interviews,cents=d.cents+excluded.cents,
 remote_found=d.remote_found+excluded.remote_found,remote_applied=d.remote_applied+excluded.remote_applied,
 onsite_hybrid_found=d.onsite_hybrid_found+excluded.onsite_hybrid_found,onsite_hybrid_applied=d.onsite_hybrid_applied+excluded.onsite_hybrid_applied,
 unspecified_found=d.unspecified_found+excluded.unspecified_found,unspecified_applied=d.unspecified_applied+excluded.unspecified_applied;
 if exists(select 1 from old_bids o join new_bids n on n.id=o.id where
 (o.workspace_id,o.bidder_id,o.resume_id,o.deleted_at,o.applied,o.found_at,o.applied_at,o.first_applied_at) is distinct from
 (n.workspace_id,n.bidder_id,n.resume_id,n.deleted_at,n.applied,n.found_at,n.applied_at,n.first_applied_at)) then
 delete from private.bid_report_daily d using (select c.*,1 as sign from new_bids b cross join lateral private.bid_report_contributions(b) c union all select c.*,-1 as sign from old_bids b cross join lateral private.bid_report_contributions(b) c) delta
 where (d.workspace_id,d.bidder_id,d.resume_id,d.day,d.metric)=(delta.workspace_id,delta.bidder_id,delta.resume_id,delta.day,delta.metric) and d.n=0;
 end if;
 return null;
end $$;
revoke all on function private.maintain_bid_report_daily_update() from public,anon,authenticated;
create trigger bid_report_insert after insert on public.bids referencing new table as new_bids for each statement execute function private.maintain_bid_report_daily_insert();
create trigger bid_report_update after update on public.bids referencing old table as old_bids new table as new_bids for each statement execute function private.maintain_bid_report_daily_update();
create trigger bid_report_delete after delete on public.bids referencing old table as old_bids for each statement execute function private.maintain_bid_report_daily_delete();

create function private.rebuild_bid_report_daily() returns void
language plpgsql security definer set search_path='' as $$
begin
 lock table public.bids in share row exclusive mode;
 delete from private.bid_report_daily;
 insert into private.bid_report_daily
 select c.workspace_id,c.bidder_id,c.resume_id,c.day,c.metric,sum(c.n),sum(c.found_applied),sum(c.tracked),sum(c.interviews),sum(c.cents),
 sum(c.remote_found),sum(c.remote_applied),sum(c.onsite_hybrid_found),sum(c.onsite_hybrid_applied),sum(c.unspecified_found),sum(c.unspecified_applied)
 from public.bids b cross join lateral private.bid_report_contributions(b) c group by c.workspace_id,c.bidder_id,c.resume_id,c.day,c.metric;
end $$;
create function private.reconcile_bid_report_daily() returns bigint
language sql stable security definer set search_path='' as $$
 with expected as (select c.workspace_id,c.bidder_id,c.resume_id,c.day,c.metric,sum(c.n) n,sum(c.found_applied) found_applied,sum(c.tracked) tracked,sum(c.interviews) interviews,sum(c.cents) cents,
 sum(c.remote_found) remote_found,sum(c.remote_applied) remote_applied,sum(c.onsite_hybrid_found) onsite_hybrid_found,sum(c.onsite_hybrid_applied) onsite_hybrid_applied,sum(c.unspecified_found) unspecified_found,sum(c.unspecified_applied) unspecified_applied
 from public.bids b cross join lateral private.bid_report_contributions(b) c group by c.workspace_id,c.bidder_id,c.resume_id,c.day,c.metric),
 differences as ((select * from expected except select * from private.bid_report_daily) union all (select * from private.bid_report_daily except select * from expected)) select count(*) from differences
$$;
revoke all on function private.rebuild_bid_report_daily(),private.reconcile_bid_report_daily() from public,anon,authenticated;
select private.rebuild_bid_report_daily();

alter function private.dashboard_report_events(date,date,uuid,uuid,uuid) rename to dashboard_report_events_legacy;
alter function private.report_events(date,date,uuid,uuid,uuid,boolean) rename to report_events_legacy;
create function private.dashboard_report_events(p_from date,p_to date,p_workspace uuid,p_bidder uuid,p_profile uuid)
returns table(day date,metric text,bidder_id uuid,profile_id uuid,resume_id uuid,n bigint,found_applied bigint,tracked bigint,interviews bigint,cents bigint,retained bigint,remote_found bigint,remote_applied bigint,onsite_hybrid_found bigint,onsite_hybrid_applied bigint,unspecified_found bigint,unspecified_applied bigint)
language sql stable security definer set search_path='' as $$
 with scope as materialized (select s.* from private.readable_bid_scope() s where (p_workspace is null or s.workspace_id=p_workspace) and (p_bidder is null or s.bidder_id=p_bidder)), events as (
 select d.day,d.metric,d.bidder_id,r.profile_id,d.resume_id,d.n,d.found_applied,d.tracked,d.interviews,d.cents,0::bigint retained,d.remote_found,d.remote_applied,d.onsite_hybrid_found,d.onsite_hybrid_applied,d.unspecified_found,d.unspecified_applied
 from private.bid_report_daily d join scope s on s.workspace_id=d.workspace_id and s.bidder_id=d.bidder_id join public.resumes r on r.id=d.resume_id
 where d.day>=coalesce(p_from,'-infinity'::date) and d.day<coalesce(p_to,(current_timestamp at time zone 'America/Chicago')::date)+1 and (p_profile is null or r.profile_id=p_profile)
 union all select a.report_day,a.metric,a.bidder_id,a.profile_id,a.resume_id,a.record_count,case when a.metric='found' then a.record_count else 0 end,a.tracked_count,a.interview_count,a.earned_cents,case when a.metric='earning' then a.record_count else 0 end,
 case when a.metric='found' then a.remote_count else 0 end,case when a.metric='found' then a.remote_count else 0 end,
 case when a.metric='found' then a.onsite_count+a.hybrid_count else 0 end,case when a.metric='found' then a.onsite_count+a.hybrid_count else 0 end,
 case when a.metric='found' then a.record_count-a.remote_count-a.onsite_count-a.hybrid_count else 0 end,case when a.metric='found' then a.record_count-a.remote_count-a.onsite_count-a.hybrid_count else 0 end
 from public.retained_bid_daily_aggregates a join scope s on s.workspace_id=a.workspace_id and s.bidder_id=a.bidder_id
 where a.report_day>=coalesce(p_from,'-infinity'::date) and a.report_day<coalesce(p_to,(current_timestamp at time zone 'America/Chicago')::date)+1 and (p_profile is null or a.profile_id=p_profile))
 select day,metric,bidder_id,profile_id,resume_id,sum(n)::bigint,sum(found_applied)::bigint,sum(tracked)::bigint,sum(interviews)::bigint,sum(cents)::bigint,sum(retained)::bigint,
 sum(remote_found)::bigint,sum(remote_applied)::bigint,sum(onsite_hybrid_found)::bigint,sum(onsite_hybrid_applied)::bigint,sum(unspecified_found)::bigint,sum(unspecified_applied)::bigint from events group by day,metric,bidder_id,profile_id,resume_id
$$;
create function private.report_events(p_from date,p_to date,p_workspace uuid,p_bidder uuid,p_profile uuid,p_cohort_only boolean)
returns table(day date,metric text,bidder_id uuid,profile_id uuid,resume_id uuid,n bigint,found_applied bigint,tracked bigint,interviews bigint,cents bigint,retained bigint)
language sql stable security definer set search_path='' as $$
 select day,metric,bidder_id,profile_id,resume_id,n,found_applied,tracked,interviews,cents,retained from private.dashboard_report_events(p_from,p_to,p_workspace,p_bidder,p_profile) where not p_cohort_only or metric='earning'
$$;
revoke all on function private.dashboard_report_events(date,date,uuid,uuid,uuid),private.report_events(date,date,uuid,uuid,uuid,boolean) from public,anon,authenticated;

create table private.mail_mailboxes (
 client_id uuid not null references public.mail_insights_state(client_id) on delete cascade,
 email text not null, account_label text not null,collected_at timestamptz,coverage_start date,
 primary key(client_id,email)
);
create table private.mail_daily (
 client_id uuid not null,email text not null,day date not null,category text not null,
 handled boolean not null,action_required boolean not null,retryable boolean not null,n bigint not null check(n>=0),
 primary key(client_id,email,day,category,handled,action_required,retryable),
 foreign key(client_id,email) references private.mail_mailboxes(client_id,email) on delete cascade
);
create index mail_daily_day on private.mail_daily(day,client_id,email);
revoke all on private.mail_mailboxes,private.mail_daily from public,anon,authenticated;
insert into private.mail_mailboxes select s.client_id,m->>'email',m->>'account_label',(m->>'collected_at')::timestamptz,(m->>'coverage_start')::date from public.mail_insights_state s cross join lateral jsonb_array_elements(s.mailboxes) m;
insert into private.mail_daily select s.client_id,m->>'email',(r->>'date')::date,r->>'category',(r->>'handled')::boolean,(r->>'action_required')::boolean,(r->>'retryable')::boolean,(r->>'count')::bigint from public.mail_insights_state s cross join lateral jsonb_array_elements(s.mailboxes) m cross join lateral jsonb_array_elements(m->'rows') r;

-- Preserve v1 validation while validating only changed cubes for v2.
-- No accepted snapshot is written to a redundant mailbox JSON blob.
create function private.validate_mail_snapshot(p_snapshot jsonb) returns void
language plpgsql set search_path='' as $$
declare m jsonb; r jsonb; rev bigint; seen_emails text[]:='{}'; seen_rows text[]; k text; day date;
 today date:=(current_timestamp at time zone 'America/Chicago')::date; total numeric:=0;
begin
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
end $$;
revoke all on function private.validate_mail_snapshot(jsonb) from public,anon,authenticated;

create or replace function public.ingest_mail_insights(p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); w uuid; prior public.mail_insights_state; m jsonb; old_m jsonb; expanded jsonb; full_payload jsonb; hashed text; seen text[]:='{}'; rev bigint;
begin
 select ws.id into w from public.workspaces ws join public.profiles p on p.id=ws.owner_id where p.id=actor and p.role='client' and not p.archived and p.approval_status='approved';
 if w is null or p_snapshot->>'client_id' is distinct from actor::text then raise exception 'Access denied' using errcode='42501'; end if;
 insert into public.mail_insights_state(client_id,workspace_id) values(actor,w) on conflict(client_id) do nothing;
 select * into prior from public.mail_insights_state where client_id=actor for update;
 if octet_length(p_snapshot::text)>2097152 then raise exception 'Invalid snapshot' using errcode='22023'; end if;
 hashed:=encode(sha256(convert_to(p_snapshot::text,'UTF8')),'hex');
 if p_snapshot->>'revision' !~ '^[0-9]+$' or (p_snapshot->>'revision')::numeric not between 1 and 9007199254740991 then raise exception 'Invalid snapshot' using errcode='22023'; end if;
 rev:=(p_snapshot->>'revision')::bigint;
 if rev=prior.last_revision and hashed=prior.original_hash then return jsonb_build_object('ok',true,'revision',rev,'received_at',prior.received_at,'unchanged',true); end if;
 if rev<=prior.last_revision then return jsonb_build_object('code','revision_conflict','last_revision',prior.last_revision); end if;
 if p_snapshot->'schema_version'='1'::jsonb then
  perform private.validate_mail_snapshot(p_snapshot); full_payload:=p_snapshot;
 elsif p_snapshot->'schema_version'='2'::jsonb then
  if not private.mail_insights_keys(p_snapshot,case when p_snapshot->>'mode'='delta' then array['schema_version','client_id','revision','generated_at','timezone','mode','base_revision','mailboxes','removed_mailboxes'] else array['schema_version','client_id','revision','generated_at','timezone','mode','mailboxes','removed_mailboxes'] end)
   or p_snapshot->>'mode' is null or p_snapshot->>'mode' not in ('full','delta') or jsonb_typeof(p_snapshot->'removed_mailboxes')<>'array' or jsonb_typeof(p_snapshot->'mailboxes')<>'array' then raise exception 'Invalid snapshot' using errcode='22023'; end if;
  if p_snapshot->>'mode'='delta' then
   if jsonb_typeof(p_snapshot->'base_revision')<>'number' or p_snapshot->>'base_revision' !~ '^[0-9]+$' then raise exception 'Invalid snapshot' using errcode='22023'; end if;
   if (p_snapshot->>'base_revision')::numeric<>prior.last_revision then return jsonb_build_object('code','revision_conflict','last_revision',prior.last_revision); end if;
  end if;
  expanded:='[]'::jsonb;
  for m in select value from jsonb_array_elements(p_snapshot->'mailboxes') loop
   if (m->>'email')=any(seen) or not private.mail_insights_keys(m,case when m ? 'rows' then array['email','account_label','collected_at','coverage_start','rows'] else array['email','account_label','collected_at','coverage_start'] end) then raise exception 'Invalid snapshot' using errcode='22023'; end if;
   seen:=array_append(seen,m->>'email');
   if not(m ? 'rows') then
    if p_snapshot->>'mode'<>'delta' or not exists(select 1 from private.mail_mailboxes where client_id=actor and email=m->>'email') then raise exception 'Invalid snapshot' using errcode='22023'; end if;
    old_m:='[]'::jsonb;
    m:=m||jsonb_build_object('rows',old_m);
   end if;
   expanded:=expanded||jsonb_build_array(m);
  end loop;
  if exists(select 1 from jsonb_array_elements(p_snapshot->'removed_mailboxes') e where jsonb_typeof(e)<>'string' or e#>>'{}'=any(seen)) then raise exception 'Invalid snapshot' using errcode='22023'; end if;
  if p_snapshot->>'mode'='full' and jsonb_array_length(p_snapshot->'removed_mailboxes')<>0 then raise exception 'Invalid snapshot' using errcode='22023'; end if;
  full_payload:=(p_snapshot-'mode'-'base_revision'-'removed_mailboxes')||jsonb_build_object('schema_version',1,'mailboxes',expanded);
  perform private.validate_mail_snapshot(full_payload);
 else raise exception 'Invalid snapshot' using errcode='22023'; end if;
 -- Only replace cubes for changed mailboxes; metadata-only deltas preserve the
 -- rows in place, avoiding unnecessary WAL and index churn.
 if p_snapshot->'schema_version'='1'::jsonb or p_snapshot->>'mode'='full' then
  delete from private.mail_mailboxes b where b.client_id=actor and not exists(select 1 from jsonb_array_elements(full_payload->'mailboxes') e where e->>'email'=b.email);
 else
  delete from private.mail_mailboxes b where b.client_id=actor and exists(select 1 from jsonb_array_elements_text(p_snapshot->'removed_mailboxes') e where e=b.email);
 end if;
 for m in select value from jsonb_array_elements(full_payload->'mailboxes') loop
  insert into private.mail_mailboxes values(actor,m->>'email',m->>'account_label',(m->>'collected_at')::timestamptz,(m->>'coverage_start')::date)
  on conflict(client_id,email) do update set account_label=excluded.account_label,collected_at=excluded.collected_at,coverage_start=excluded.coverage_start;
  if p_snapshot->'schema_version'='1'::jsonb or p_snapshot->>'mode'='full' or exists(select 1 from jsonb_array_elements(p_snapshot->'mailboxes') e where e->>'email'=m->>'email' and e ? 'rows') then
   delete from private.mail_daily where client_id=actor and email=m->>'email';
   insert into private.mail_daily select actor,m->>'email',(r->>'date')::date,r->>'category',(r->>'handled')::boolean,(r->>'action_required')::boolean,(r->>'retryable')::boolean,(r->>'count')::bigint from jsonb_array_elements(m->'rows') r;
  end if;
 end loop;
 if (select count(*) from private.mail_mailboxes where client_id=actor)>500 or (select coalesce(sum(n),0) from private.mail_daily where client_id=actor)>9007199254740991 then raise exception 'Invalid snapshot' using errcode='22023'; end if;
 update public.mail_insights_state set last_revision=rev,original_hash=hashed,generated_at=(p_snapshot->>'generated_at')::timestamptz,received_at=clock_timestamp(),mailboxes='[]'::jsonb where client_id=actor returning * into prior;
 return jsonb_build_object('ok',true,'revision',rev,'received_at',prior.received_at,'unchanged',false);
end $$;
revoke all on function public.ingest_mail_insights(jsonb) from public,anon;
grant execute on function public.ingest_mail_insights(jsonb) to authenticated;

-- Reusable coverage calculation: mailbox identity is deduplicated before
-- intersection; absence of any required mailbox never becomes a known zero.
create function private.mail_report_coverage(p_report jsonb) returns jsonb
language sql stable set search_path='' as $$
 with emails as (select distinct lower(trim(a->>'email')) email from jsonb_array_elements(p_report->'assignments') a where trim(a->>'email')<>''),
 boxes as (select e.email,(m->>'collected_at')::timestamptz collected,(m->>'coverage_start')::date started from emails e left join lateral (select m from jsonb_array_elements(p_report->'mailboxes') m where m->>'email'=e.email) b on true),
 bounds as (select count(*) n,count(collected) collected_n,count(started) started_n,max(collected) updated,
 greatest(max(started),(current_timestamp at time zone 'America/Chicago')::date-89) lo,
 least(min((collected at time zone 'America/Chicago')::date),(current_timestamp at time zone 'America/Chicago')::date) hi from boxes)
 select jsonb_build_object('status',case when n>0 and n=collected_n and n=started_n and lo<=hi then 'ready' else 'not_synced' end,
 'updatedAt',updated,'from',case when n>0 and n=collected_n and n=started_n and lo<=hi then lo end,
 'to',case when n>0 and n=collected_n and n=started_n and lo<=hi then hi end) from bounds
$$;
revoke all on function private.mail_report_coverage(jsonb) from public,anon,authenticated;

create function public.mail_collection_status(p_workspace uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare role_name text; result jsonb;
begin
 role_name:=private.validate_report(null,null,p_workspace,null,null,'profile',false);
 if role_name='admin' and p_workspace is null then raise exception 'Choose a workspace' using errcode='22023'; end if;
 with ws as (select w.id,w.owner_id from public.workspaces w where (p_workspace is null or w.id=p_workspace) and (public.manages(w.id) or exists(select 1 from public.bidders b where b.workspace_id=w.id and b.user_id=auth.uid() and public.can_read(w.id,b.user_id)))),
 assigned as (select distinct w.owner_id client_id,lower(trim(r.email)) email from public.resumes r join ws w on w.id=r.workspace_id join public.candidate_profiles cp on cp.id=r.profile_id join public.bidders b on b.user_id=r.bidder_id join public.profiles bp on bp.id=b.user_id
 where trim(r.email)<>'' and public.can_read(r.workspace_id,r.bidder_id) and (role_name<>'bidder' or (r.bidder_id=auth.uid() and not r.archived and not cp.archived and not b.archived and not bp.archived))),
 emails as (select * from assigned union select b.client_id,b.email from private.mail_mailboxes b join ws w on w.owner_id=b.client_id where role_name<>'bidder'),
 boxes as (select e.email,b.collected_at,b.coverage_start from emails e left join private.mail_mailboxes b on b.client_id=e.client_id and b.email=e.email)
 select jsonb_build_object('assignments',coalesce((select jsonb_agg(jsonb_build_object('email',email)) from boxes),'[]'),
 'mailboxes',coalesce((select jsonb_agg(jsonb_build_object('email',email,'collected_at',collected_at,'coverage_start',coverage_start)) from boxes),'[]')) into result;
 return private.mail_report_coverage(result);
end $$;
revoke all on function public.mail_collection_status(uuid) from public,anon;
grant execute on function public.mail_collection_status(uuid) to authenticated;

create function public.workspace_report_bundle(p_kind text,p_from date default null,p_to date default null,p_workspace uuid default null,p_bidder uuid default null,p_profile uuid default null,p_email text default null,p_group text default 'profile') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare role_name text; mail jsonb; coverage jsonb; collection jsonb; application_report jsonb; cohort jsonb; rates jsonb; mail_rates jsonb; lo date; hi date; invitation_count bigint; total_rate numeric; ready boolean;
begin
 if p_kind not in ('overview','interviews','earnings') then raise exception 'Invalid report kind' using errcode='22023'; end if;
 role_name:=private.validate_report(p_from,p_to,p_workspace,p_bidder,p_profile,p_group,p_kind='earnings');
 if p_email is not null and (length(p_email)>320 or p_email!~'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then raise exception 'Invalid email' using errcode='22023'; end if;
 -- Platform-wide bid reports remain useful until an admin chooses a mail workspace.
 if role_name='admin' and p_workspace is null then
  mail:=null; collection:=jsonb_build_object('status','not_synced','updatedAt',null,'from',null,'to',null); coverage:=collection;
 else
  mail:=public.mail_insights_report(p_from,p_to,p_workspace,p_bidder,p_profile,p_email);
  collection:=public.mail_collection_status(p_workspace);
  coverage:=private.mail_report_coverage(mail);
 end if;
 ready:=coverage->>'status'='ready';
 lo:=greatest(p_from,(coverage->>'from')::date); hi:=least(p_to,(coverage->>'to')::date);
 ready:=ready and lo<=hi;
 if ready then
  cohort:=private.mail_application_cohort(lo,hi,p_workspace,p_bidder,p_profile,p_email,p_group,mail->'assignments');
  mail_rates:=public.mail_insights_report(lo,hi,p_workspace,p_bidder,p_profile,p_email);
  -- Only assigned mailbox sets contribute invitations to application rates.
  select coalesce(sum((r->>'count')::bigint),0) into invitation_count from jsonb_array_elements(mail_rates->'mailboxes') m cross join lateral jsonb_array_elements(m->'rows') r
  where r->>'category'='interview_invite' and exists(select 1 from jsonb_array_elements(mail_rates->'assignments') a where a->>'email'=m->>'email');
  if (cohort->'totals'->>'applied')::bigint>0 then total_rate:=round(invitation_count*100.0/(cohort->'totals'->>'applied')::bigint,1); end if;
  select coalesce(jsonb_object_agg(g->>'id',jsonb_build_object('invitations',v.n,'applications',(g->>'applied')::bigint,'rate',case when (g->>'applied')::bigint>0 then round(v.n*100.0/(g->>'applied')::bigint,1) end)),'{}') into rates
  from jsonb_array_elements(cohort->'groups') g cross join lateral (
   select coalesce(sum((r->>'count')::bigint),0) n from jsonb_array_elements(mail_rates->'mailboxes') m cross join lateral jsonb_array_elements(m->'rows') r where r->>'category'='interview_invite' and exists(select 1 from jsonb_array_elements(mail_rates->'assignments') a where a->>'email'=m->>'email' and case p_group when 'bidder' then a->>'bidder_id' when 'profile' then a->>'profile_id' else a->>'id' end=g->>'id')
  ) v;
 else
  cohort:=jsonb_build_object('totals',jsonb_build_object('applied',0,'interviews',0,'excludedApplications',0),'groups','[]'::jsonb); invitation_count:=0; rates:='{}'::jsonb;
 end if;
 if p_kind='overview' then
  if p_email is null then application_report:=public.dashboard_performance_v2(p_from,p_to,p_workspace,p_bidder,p_profile);
  else application_report:=public.dashboard_email_performance(p_from,p_to,p_workspace,p_bidder,p_profile,p_email); end if;
 elsif p_kind='earnings' then application_report:=public.earnings_performance_v2(p_from,p_to,p_workspace,p_bidder,p_profile,p_group);
 else application_report:=cohort; if ready then mail:=mail_rates; end if;
 end if;
 return jsonb_build_object('report',application_report,'mail',mail,'collection',collection,
 'interviewPeriod',case when ready then jsonb_build_object('from',lo,'to',hi) end,
 'interview',jsonb_build_object('invitations',case when ready then invitation_count end,'applications',case when ready then (cohort->'totals'->>'applied')::bigint end,'rate',total_rate,'groups',rates));
end $$;
revoke all on function public.workspace_report_bundle(text,date,date,uuid,uuid,uuid,text,text) from public,anon;
grant execute on function public.workspace_report_bundle(text,date,date,uuid,uuid,uuid,text,text) to authenticated;

-- This gate is private and can be toggled by the deployment operator to fall
-- back to raw readers without modifying application code.
create table private.reporting_rollout(singleton boolean primary key default true check(singleton),use_summaries boolean not null default true);
insert into private.reporting_rollout values(true,true);
revoke all on private.reporting_rollout from public,anon,authenticated;

create function private.mail_application_cohort(p_from date,p_to date,p_workspace uuid,p_bidder uuid,p_profile uuid,p_email text,p_group text,p_assignments jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
 with events as (select e.*,case p_group when 'bidder' then e.bidder_id when 'profile' then e.profile_id else e.resume_id end id,
 case p_group when 'bidder' then bp.display_name when 'profile' then cp.identifier else cp.identifier||' · '||bp.display_name end label
 from private.report_events(p_from,p_to,p_workspace,p_bidder,p_profile,true) e join public.resumes r on r.id=e.resume_id join public.profiles bp on bp.id=e.bidder_id join public.candidate_profiles cp on cp.id=e.profile_id
 where (p_email is null or lower(trim(r.email))=lower(trim(p_email))) and exists(select 1 from jsonb_array_elements(p_assignments) a where a->>'id'=e.resume_id::text and trim(a->>'email')<>'')), grouped as (select id,max(label) label,sum(tracked) applied,sum(interviews) interviews from events group by id)
 select jsonb_build_object('totals',jsonb_build_object('applied',coalesce((select sum(tracked) from events),0),'interviews',coalesce((select sum(interviews) from events),0),'excludedApplications',coalesce((select sum(greatest(n-tracked,0)) from events),0)),
 'groups',coalesce((select jsonb_agg(jsonb_build_object('id',id,'label',label,'applied',applied,'interviews',interviews,'conversion',null) order by id) from grouped),'[]'))
$$;
revoke all on function private.mail_application_cohort(date,date,uuid,uuid,uuid,text,text,jsonb) from public,anon,authenticated;

create or replace function public.prune_mail_insights(p_limit integer default 100) returns integer
language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
 if p_limit not between 1 and 1000 then raise exception 'Invalid limit'; end if;
 with batch as (select s.client_id from public.mail_insights_state s where exists(select 1 from private.mail_daily d where d.client_id=s.client_id and d.day<(current_timestamp at time zone 'America/Chicago')::date-89) limit p_limit for update skip locked),
 deleted as (delete from private.mail_daily d using batch b where d.client_id=b.client_id and d.day<(current_timestamp at time zone 'America/Chicago')::date-89 returning d.client_id)
 select count(distinct client_id)::integer into changed from deleted;
 return changed;
end $$;

alter function private.dashboard_report_events(date,date,uuid,uuid,uuid) rename to dashboard_report_events_summary;
create function private.dashboard_report_events(p_from date,p_to date,p_workspace uuid,p_bidder uuid,p_profile uuid)
returns table(day date,metric text,bidder_id uuid,profile_id uuid,resume_id uuid,n bigint,found_applied bigint,tracked bigint,interviews bigint,cents bigint,retained bigint,remote_found bigint,remote_applied bigint,onsite_hybrid_found bigint,onsite_hybrid_applied bigint,unspecified_found bigint,unspecified_applied bigint)
language sql stable security definer set search_path='' as $$
 select * from private.dashboard_report_events_summary(p_from,p_to,p_workspace,p_bidder,p_profile) where (select use_summaries from private.reporting_rollout where singleton)
 union all select * from private.dashboard_report_events_legacy(p_from,p_to,p_workspace,p_bidder,p_profile) where not(select use_summaries from private.reporting_rollout where singleton)
$$;
revoke all on function private.dashboard_report_events(date,date,uuid,uuid,uuid) from public,anon,authenticated;

create or replace function public.mail_insights_report(p_from date,p_to date,p_workspace uuid,p_bidder uuid,p_profile uuid,p_email text) returns jsonb
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
  select jsonb_build_object('email',b.email,'account_label',b.account_label,'collected_at',b.collected_at,'coverage_start',b.coverage_start,'rows',coalesce((select jsonb_agg(jsonb_build_object('date',d.day,'category',d.category,'handled',d.handled,'action_required',d.action_required,'retryable',d.retryable,'count',d.n) order by d.day,d.category,d.handled,d.action_required,d.retryable) from private.mail_daily d where d.client_id=b.client_id and d.email=b.email and d.day between lo and hi),'[]'::jsonb)) mailbox from scoped s join private.mail_mailboxes b on b.client_id=s.client_id
  where (p_email is null or b.email=lower(trim(p_email)))
  and ((role_name<>'bidder' and p_bidder is null and p_profile is null) or exists(
   select 1 from assignments a where a.workspace_id=s.workspace_id and a.email=b.email))
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
