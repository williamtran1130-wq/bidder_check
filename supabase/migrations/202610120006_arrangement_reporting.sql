-- Existing retained records have no arrangement history. Zero known counters
-- leave them Unspecified; future cleanup preserves the arrangement at deletion.
alter table public.retained_bid_daily_aggregates
 add column remote_count bigint not null default 0 check(remote_count>=0),
 add column onsite_count bigint not null default 0 check(onsite_count>=0),
 add column hybrid_count bigint not null default 0 check(hybrid_count>=0),
 add constraint retained_arrangement_count_bounds check(remote_count::numeric+onsite_count+hybrid_count<=record_count);
grant select(remote_count,onsite_count,hybrid_count) on public.retained_bid_daily_aggregates to authenticated;

-- Dashboard-specific events keep the shared financial/interview helper stable.
create function private.dashboard_report_events(p_from date,p_to date,p_workspace uuid,p_bidder uuid,p_profile uuid)
returns table(day date,metric text,bidder_id uuid,profile_id uuid,resume_id uuid,n bigint,found_applied bigint,tracked bigint,interviews bigint,cents bigint,retained bigint,remote_found bigint,remote_applied bigint,onsite_hybrid_found bigint,onsite_hybrid_applied bigint,unspecified_found bigint,unspecified_applied bigint)
language sql stable security definer set search_path='' as $$
 with scope as materialized (
  select s.workspace_id,s.bidder_id from private.readable_bid_scope() s
  where (p_workspace is null or s.workspace_id=p_workspace) and (p_bidder is null or s.bidder_id=p_bidder)
 ), bounds as not materialized (
  select coalesce(p_from::timestamp at time zone 'America/Chicago','-infinity'::timestamptz) lo,
   (coalesce(p_to,(current_timestamp at time zone 'America/Chicago')::date)+1)::timestamp at time zone 'America/Chicago' hi,
   coalesce(p_from,'-infinity'::date) day_lo,
   coalesce(p_to,(current_timestamp at time zone 'America/Chicago')::date)+1 day_hi
 ), raw_events(day,metric,bidder_id,profile_id,resume_id,n,found_applied,tracked,interviews,cents,retained,remote_found,remote_applied,onsite_hybrid_found,onsite_hybrid_applied,unspecified_found,unspecified_applied) as not materialized (
 select (b.found_at at time zone 'America/Chicago')::date,'found',b.bidder_id,r.profile_id,b.resume_id,1::bigint,b.applied::integer::bigint,0::bigint,0::bigint,0::bigint,0::bigint,
  (b.arrangement='remote')::integer::bigint,(b.arrangement='remote' and b.applied)::integer::bigint,
  (b.arrangement in ('onsite','hybrid'))::integer::bigint,(b.arrangement in ('onsite','hybrid') and b.applied)::integer::bigint,0::bigint,0::bigint
 from public.bids b join scope s on s.workspace_id=b.workspace_id and s.bidder_id=b.bidder_id join public.resumes r on r.id=b.resume_id cross join bounds
 where b.deleted_at is null and b.found_at>=bounds.lo and b.found_at<bounds.hi and (p_profile is null or r.profile_id=p_profile)
 union all
 select (b.applied_at at time zone 'America/Chicago')::date,'applied_activity',b.bidder_id,r.profile_id,b.resume_id,1,0,0,0,0,0,0,0,0,0,0,0
 from public.bids b join scope s on s.workspace_id=b.workspace_id and s.bidder_id=b.bidder_id join public.resumes r on r.id=b.resume_id cross join bounds
 where b.deleted_at is null and b.applied and b.applied_at>=bounds.lo and b.applied_at<bounds.hi and (p_profile is null or r.profile_id=p_profile)
 union all
 select (b.first_applied_at at time zone 'America/Chicago')::date,'earning',b.bidder_id,r.profile_id,b.resume_id,1,0,1,b.interview_scheduled::integer::bigint,coalesce(b.rate_cents,0)::bigint,0,0,0,0,0,0,0
 from public.bids b join scope s on s.workspace_id=b.workspace_id and s.bidder_id=b.bidder_id join public.resumes r on r.id=b.resume_id cross join bounds
 where b.deleted_at is null and b.applied and b.first_applied_at>=bounds.lo and b.first_applied_at<bounds.hi and (p_profile is null or r.profile_id=p_profile)
 union all
 select a.report_day,a.metric,a.bidder_id,a.profile_id,a.resume_id,a.record_count,case when a.metric='found' then a.record_count else 0 end,a.tracked_count,a.interview_count,a.earned_cents,case when a.metric='earning' then a.record_count else 0 end,
  case when a.metric='found' then a.remote_count else 0 end,case when a.metric='found' then a.remote_count else 0 end,
  case when a.metric='found' then a.onsite_count+a.hybrid_count else 0 end,case when a.metric='found' then a.onsite_count+a.hybrid_count else 0 end,
  case when a.metric='found' then a.record_count-a.remote_count-a.onsite_count-a.hybrid_count else 0 end,
  case when a.metric='found' then a.record_count-a.remote_count-a.onsite_count-a.hybrid_count else 0 end
 from public.retained_bid_daily_aggregates a join scope s on s.workspace_id=a.workspace_id and s.bidder_id=a.bidder_id cross join bounds
 where a.report_day>=bounds.day_lo and a.report_day<bounds.day_hi and (p_profile is null or a.profile_id=p_profile)
 )
 -- Compress before the SQL function's result tuplestore and report CTEs. The
 -- grouping retains assignment identity, every arrangement/cohort count, and money totals.
 select day,metric,bidder_id,profile_id,resume_id,
  sum(n)::bigint,sum(found_applied)::bigint,sum(tracked)::bigint,
  sum(interviews)::bigint,sum(cents)::bigint,sum(retained)::bigint,
  sum(remote_found)::bigint,sum(remote_applied)::bigint,
  sum(onsite_hybrid_found)::bigint,sum(onsite_hybrid_applied)::bigint,
  sum(unspecified_found)::bigint,sum(unspecified_applied)::bigint
 from raw_events group by day,metric,bidder_id,profile_id,resume_id
$$;

create or replace function public.dashboard_performance_v2(p_from date default null,p_to date default null,p_workspace uuid default null,p_bidder uuid default null,p_profile uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
#variable_conflict use_column
declare role_name text; report jsonb;
begin
 role_name=private.validate_report(p_from,p_to,p_workspace,p_bidder,p_profile,'profile',false);
 with events as materialized (select * from private.dashboard_report_events(p_from,p_to,p_workspace,p_bidder,p_profile)),
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

create or replace function public.process_candidate_retention(p_limit integer default 500) returns jsonb language plpgsql security definer set search_path='' as $$
declare profile record; bid record; cutoff timestamptz; batch_limit integer=least(greatest(coalesce(p_limit,500),1),2000); deleted_total integer=0; storage_count integer=0; queued integer; found_day date; applied_day date; earned_day date; begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 for profile in select id,workspace_id,retention_months from public.candidate_profiles where retention_months is not null order by id loop
  exit when deleted_total>=batch_limit;
  perform pg_advisory_xact_lock(hashtextextended(profile.id::text,0));
  cutoff=public.candidate_retention_cutoff(clock_timestamp(),profile.retention_months);
  for bid in
   select b.id,b.workspace_id,b.bidder_id,b.resume_id,b.found_at,b.applied_at,b.first_applied_at,b.rate_cents,b.deleted_at,b.evidence_file_id,b.interview_scheduled,b.interview_tracking,b.arrangement
   from public.bids b join public.resumes r on r.id=b.resume_id
   where r.profile_id=profile.id and b.applied and b.applied_at<cutoff
   order by b.applied_at,b.id for update of b skip locked limit least(batch_limit-deleted_total,200)
  loop
   if bid.deleted_at is null then
    found_day=(bid.found_at at time zone 'America/Chicago')::date;
    applied_day=(bid.applied_at at time zone 'America/Chicago')::date;
    earned_day=(bid.first_applied_at at time zone 'America/Chicago')::date;
    insert into public.retained_bid_daily_aggregates(workspace_id,profile_id,bidder_id,resume_id,report_day,metric,record_count,earned_cents,remote_count,onsite_count,hybrid_count)
     values(bid.workspace_id,profile.id,bid.bidder_id,bid.resume_id,found_day,'found',1,0,
      (bid.arrangement='remote')::integer,(bid.arrangement='onsite')::integer,(bid.arrangement='hybrid')::integer)
     on conflict(workspace_id,profile_id,bidder_id,resume_id,report_day,metric) do update set
      record_count=public.retained_bid_daily_aggregates.record_count+excluded.record_count,
      remote_count=public.retained_bid_daily_aggregates.remote_count+excluded.remote_count,
      onsite_count=public.retained_bid_daily_aggregates.onsite_count+excluded.onsite_count,
      hybrid_count=public.retained_bid_daily_aggregates.hybrid_count+excluded.hybrid_count;
    insert into public.retained_bid_daily_aggregates(workspace_id,profile_id,bidder_id,resume_id,report_day,metric,record_count,earned_cents)
     values(bid.workspace_id,profile.id,bid.bidder_id,bid.resume_id,applied_day,'applied_activity',1,0)
     on conflict(workspace_id,profile_id,bidder_id,resume_id,report_day,metric) do update set record_count=public.retained_bid_daily_aggregates.record_count+1;
    insert into public.retained_bid_daily_aggregates(workspace_id,profile_id,bidder_id,resume_id,report_day,metric,record_count,earned_cents,interview_count,interview_tracking,tracked_count)
     values(bid.workspace_id,profile.id,bid.bidder_id,bid.resume_id,earned_day,'earning',1,coalesce(bid.rate_cents,0),case when bid.interview_scheduled then 1 else 0 end,bid.interview_tracking,case when bid.interview_tracking then 1 else 0 end)
     on conflict(workspace_id,profile_id,bidder_id,resume_id,report_day,metric) do update set record_count=public.retained_bid_daily_aggregates.record_count+1,earned_cents=public.retained_bid_daily_aggregates.earned_cents+excluded.earned_cents,interview_count=public.retained_bid_daily_aggregates.interview_count+excluded.interview_count,tracked_count=public.retained_bid_daily_aggregates.tracked_count+excluded.tracked_count,interview_tracking=public.retained_bid_daily_aggregates.interview_tracking or excluded.interview_tracking;
   end if;
   insert into public.storage_cleanup_tasks(operation_id,storage_path) select null,f.storage_path from public.files f where f.bid_id=bid.id and f.kind='screenshot';
   get diagnostics queued=row_count; storage_count=storage_count+queued;
   delete from public.bid_events where bid_id=bid.id;
   update public.bids set evidence_file_id=null,applied=false where id=bid.id;
   delete from public.files where bid_id=bid.id and kind='screenshot';
   delete from public.bids where id=bid.id;
   deleted_total=deleted_total+1;
  end loop;
 end loop;
 return jsonb_build_object('deletedApplications',deleted_total,'storageTasksQueued',storage_count,'limit',batch_limit);
end $$;
revoke all on function public.process_candidate_retention(integer) from public,anon,authenticated;
grant execute on function public.process_candidate_retention(integer) to service_role;

revoke all on function private.dashboard_report_events(date,date,uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.dashboard_performance_v2(date,date,uuid,uuid,uuid) from public,anon;
grant execute on function public.dashboard_performance_v2(date,date,uuid,uuid,uuid) to authenticated;
