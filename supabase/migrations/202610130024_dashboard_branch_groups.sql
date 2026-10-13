-- Preaggregate each live branch at the same five-key identity before UNION.
-- Merge with retained rows afterward, preserving all twelve bigint counters.
create or replace function private.dashboard_report_events(p_from date,p_to date,p_workspace uuid,p_bidder uuid,p_profile uuid)
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
 select (b.found_at at time zone 'America/Chicago')::date,'found',b.bidder_id,r.profile_id,b.resume_id,count(*)::bigint,sum(b.applied::integer)::bigint,0::bigint,0::bigint,0::bigint,0::bigint,
  sum((b.arrangement='remote')::integer)::bigint,sum((b.arrangement='remote' and b.applied)::integer)::bigint,
  sum((b.arrangement in ('onsite','hybrid'))::integer)::bigint,sum((b.arrangement in ('onsite','hybrid') and b.applied)::integer)::bigint,0::bigint,0::bigint
 from public.bids b join scope s on s.workspace_id=b.workspace_id and s.bidder_id=b.bidder_id join public.resumes r on r.id=b.resume_id cross join bounds
 where b.deleted_at is null and b.found_at>=bounds.lo and b.found_at<bounds.hi and (p_profile is null or r.profile_id=p_profile)
 group by 1,b.bidder_id,r.profile_id,b.resume_id
 union all
 select (b.applied_at at time zone 'America/Chicago')::date,'applied_activity',b.bidder_id,r.profile_id,b.resume_id,count(*)::bigint,0,0,0,0,0,0,0,0,0,0,0
 from public.bids b join scope s on s.workspace_id=b.workspace_id and s.bidder_id=b.bidder_id join public.resumes r on r.id=b.resume_id cross join bounds
 where b.deleted_at is null and b.applied and b.applied_at>=bounds.lo and b.applied_at<bounds.hi and (p_profile is null or r.profile_id=p_profile)
 group by 1,b.bidder_id,r.profile_id,b.resume_id
 union all
 select (b.first_applied_at at time zone 'America/Chicago')::date,'earning',b.bidder_id,r.profile_id,b.resume_id,count(*)::bigint,0,count(*)::bigint,sum(b.interview_scheduled::integer)::bigint,sum(coalesce(b.rate_cents,0))::bigint,0,0,0,0,0,0,0
 from public.bids b join scope s on s.workspace_id=b.workspace_id and s.bidder_id=b.bidder_id join public.resumes r on r.id=b.resume_id cross join bounds
 where b.deleted_at is null and b.applied and b.first_applied_at>=bounds.lo and b.first_applied_at<bounds.hi and (p_profile is null or r.profile_id=p_profile)
 group by 1,b.bidder_id,r.profile_id,b.resume_id
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
