-- Reporting v2: permission-safe narrow event rows; each report resolves scope once.
create index bids_active_applied_at on public.bids(applied_at,workspace_id,bidder_id) where deleted_at is null and applied;
create index retained_report_day on public.retained_bid_daily_aggregates(report_day,workspace_id,bidder_id);

create function private.validate_report(p_from date,p_to date,p_workspace uuid,p_bidder uuid,p_profile uuid,p_group text,p_financial boolean)
returns text language plpgsql stable security definer set search_path='' as $$
declare role_name text;
begin
 if auth.uid() is null then raise exception 'Access denied'; end if;
 if (p_from is null) <> (p_to is null) or p_to<p_from then raise exception 'Choose a valid date range'; end if;
 if p_group is null or p_group not in ('bidder','profile','assignment') then raise exception 'Invalid reporting group'; end if;
 select role into role_name from public.profiles where id=auth.uid() and not archived;
 if role_name is null or (p_financial and role_name='bidder') then raise exception 'Access denied'; end if;
 if role_name='bidder' then
  if p_bidder is not null and p_bidder<>auth.uid() then raise exception 'Access denied'; end if;
  if p_workspace is not null and not exists(select 1 from public.bidders where user_id=auth.uid() and workspace_id=p_workspace and not archived) then raise exception 'Access denied'; end if;
  if p_profile is not null and not exists(select 1 from public.resumes where bidder_id=auth.uid() and profile_id=p_profile and not archived) then raise exception 'Access denied'; end if;
 else
  if p_workspace is not null then perform public.require_manager(p_workspace); end if;
  if p_bidder is not null and not exists(select 1 from public.bidders where user_id=p_bidder and (p_workspace is null or workspace_id=p_workspace) and public.manages(workspace_id)) then raise exception 'Access denied'; end if;
  if p_profile is not null and not exists(select 1 from public.candidate_profiles where id=p_profile and (p_workspace is null or workspace_id=p_workspace) and public.manages(workspace_id)) then raise exception 'Access denied'; end if;
 end if;
 return role_name;
end $$;

create function private.report_events(p_from date,p_to date,p_workspace uuid,p_bidder uuid,p_profile uuid,p_cohort_only boolean)
returns table(day date,metric text,bidder_id uuid,profile_id uuid,resume_id uuid,n bigint,found_applied bigint,tracked bigint,interviews bigint,cents bigint,retained bigint)
language sql stable security definer set search_path='' as $$
 with scope as materialized (
  select s.workspace_id,s.bidder_id from private.readable_bid_scope() s
  where (p_workspace is null or s.workspace_id=p_workspace) and (p_bidder is null or s.bidder_id=p_bidder)
 ), bounds as not materialized (
  select coalesce(p_from::timestamp at time zone 'America/Chicago','-infinity'::timestamptz) lo,
   (coalesce(p_to,(current_timestamp at time zone 'America/Chicago')::date)+1)::timestamp at time zone 'America/Chicago' hi,
   coalesce(p_from,'-infinity'::date) day_lo,
   coalesce(p_to,(current_timestamp at time zone 'America/Chicago')::date)+1 day_hi
 ), raw_events(day,metric,bidder_id,profile_id,resume_id,n,found_applied,tracked,interviews,cents,retained) as not materialized (
 select (b.found_at at time zone 'America/Chicago')::date,'found',b.bidder_id,r.profile_id,b.resume_id,1::bigint,b.applied::integer::bigint,0::bigint,0::bigint,0::bigint,0::bigint
 from public.bids b join scope s on s.workspace_id=b.workspace_id and s.bidder_id=b.bidder_id join public.resumes r on r.id=b.resume_id cross join bounds
 where not p_cohort_only and b.deleted_at is null and b.found_at>=bounds.lo and b.found_at<bounds.hi and (p_profile is null or r.profile_id=p_profile)
 union all
 select (b.applied_at at time zone 'America/Chicago')::date,'applied_activity',b.bidder_id,r.profile_id,b.resume_id,1,0,0,0,0,0
 from public.bids b join scope s on s.workspace_id=b.workspace_id and s.bidder_id=b.bidder_id join public.resumes r on r.id=b.resume_id cross join bounds
 where not p_cohort_only and b.deleted_at is null and b.applied and b.applied_at>=bounds.lo and b.applied_at<bounds.hi and (p_profile is null or r.profile_id=p_profile)
 union all
 select (b.first_applied_at at time zone 'America/Chicago')::date,'earning',b.bidder_id,r.profile_id,b.resume_id,1,0,1,b.interview_scheduled::integer::bigint,coalesce(b.rate_cents,0)::bigint,0
 from public.bids b join scope s on s.workspace_id=b.workspace_id and s.bidder_id=b.bidder_id join public.resumes r on r.id=b.resume_id cross join bounds
 where b.deleted_at is null and b.applied and b.first_applied_at>=bounds.lo and b.first_applied_at<bounds.hi and (p_profile is null or r.profile_id=p_profile)
 union all
 select a.report_day,a.metric,a.bidder_id,a.profile_id,a.resume_id,a.record_count,case when a.metric='found' then a.record_count else 0 end,a.tracked_count,a.interview_count,a.earned_cents,case when a.metric='earning' then a.record_count else 0 end
 from public.retained_bid_daily_aggregates a join scope s on s.workspace_id=a.workspace_id and s.bidder_id=a.bidder_id cross join bounds
 where (not p_cohort_only or a.metric='earning') and a.report_day>=bounds.day_lo and a.report_day<bounds.day_hi and (p_profile is null or a.profile_id=p_profile)
 )
 -- Compress before the SQL function's result tuplestore and report CTEs. The
 -- grouping retains assignment identity, every cohort count, and money totals.
 select day,metric,bidder_id,profile_id,resume_id,
  sum(n)::bigint,sum(found_applied)::bigint,sum(tracked)::bigint,
  sum(interviews)::bigint,sum(cents)::bigint,sum(retained)::bigint
 from raw_events group by day,metric,bidder_id,profile_id,resume_id
$$;

create function public.dashboard_performance_v2(p_from date default null,p_to date default null,p_workspace uuid default null,p_bidder uuid default null,p_profile uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
#variable_conflict use_column
declare role_name text; report jsonb;
begin
 role_name=private.validate_report(p_from,p_to,p_workspace,p_bidder,p_profile,'profile',false);
 with events as materialized (select * from private.report_events(p_from,p_to,p_workspace,p_bidder,p_profile,false)),
 range as (select coalesce(p_from,min(day),(current_timestamp at time zone 'America/Chicago')::date) lo,coalesce(p_to,(current_timestamp at time zone 'America/Chicago')::date) hi from events),
 sizing as (select *,case when hi-lo+1<=90 then 'day'
  when (date_trunc('week',hi::timestamp)::date-date_trunc('week',lo::timestamp)::date)/7+1<=104 then 'week'
  when (extract(year from hi)-extract(year from lo))*12+extract(month from hi)-extract(month from lo)+1<=120 then 'month' else 'year' end unit from range),
 config as (select *,case when unit='year' then ceil((extract(year from hi)-extract(year from lo)+1)/120)::integer else 1 end width from sizing),
 aligned as (select *,date_trunc(unit,lo::timestamp)::date origin,make_interval(days=>case unit when 'day' then 1 when 'week' then 7 else 0 end,months=>case unit when 'month' then 1 else 0 end,years=>case unit when 'year' then width else 0 end) step from config),
 daily as (select day,coalesce(sum(n) filter(where metric='found'),0) found,coalesce(sum(found_applied) filter(where metric='found'),0) found_applied,coalesce(sum(n) filter(where metric='applied_activity'),0) applied from events group by day),
 aggregated as (select case a.unit when 'year' then make_date(extract(year from a.origin)::integer+((extract(year from d.day)::integer-extract(year from a.origin)::integer)/a.width)*a.width,1,1) else date_trunc(a.unit,d.day::timestamp)::date end bucket,sum(d.found) found,sum(d.found_applied) found_applied,sum(d.applied) applied from daily d cross join aligned a group by 1),
 buckets as (select greatest(g::date,a.lo) lo,least((g+a.step)::date-1,a.hi) hi,coalesce(t.found,0) found,coalesce(t.found_applied,0) found_applied,coalesce(t.applied,0) applied from aligned a cross join lateral generate_series(a.origin::timestamp,a.hi::timestamp,a.step) g left join aggregated t on t.bucket=g::date),
 comparisons as (select 'bidders' kind,bidder_id id,sum(n) found,sum(found_applied) found_applied from events where metric='found' group by bidder_id union all select 'profiles',profile_id,sum(n),sum(found_applied) from events where metric='found' group by profile_id),
 labels as (select c.*,case c.kind when 'bidders' then coalesce(bp.display_name,'Bidder') else coalesce(cp.identifier,'Profile') end label from comparisons c left join public.profiles bp on c.kind='bidders' and bp.id=c.id left join public.candidate_profiles cp on c.kind='profiles' and cp.id=c.id)
 select jsonb_build_object(
 'range',(select jsonb_build_object('from',lo,'to',hi,'bucketUnit',unit,'bucketSize',width) from config),
 'totals',(select jsonb_build_object('found',coalesce(sum(n) filter(where metric='found'),0),'foundApplied',coalesce(sum(found_applied) filter(where metric='found'),0),'appliedActivity',coalesce(sum(n) filter(where metric='applied_activity'),0),'trackedApplications',coalesce(sum(tracked) filter(where metric='earning'),0),'trackedInterviews',coalesce(sum(interviews) filter(where metric='earning'),0)) from events),
 'series',coalesce((select jsonb_agg(jsonb_build_object('from',lo,'to',hi,'found',found,'foundApplied',found_applied,'applied',applied) order by lo) from buckets),'[]'::jsonb),
 'comparisons',jsonb_build_object('bidders',coalesce((select jsonb_agg(jsonb_build_object('id',id,'label',label,'found',found,'foundApplied',found_applied) order by found_applied desc,found desc,id) from labels where kind='bidders'),'[]'::jsonb),'profiles',coalesce((select jsonb_agg(jsonb_build_object('id',id,'label',label,'found',found,'foundApplied',found_applied) order by found_applied desc,found desc,id) from labels where kind='profiles'),'[]'::jsonb)))
 || case when role_name='bidder' then '{}'::jsonb else jsonb_build_object('financial',(select jsonb_build_object('earningsCents',coalesce(sum(cents),0),'earningsCount',coalesce(sum(n),0)) from events where metric='earning')) end into report;
 return report;
end $$;

create function private.cohort_report(p_from date,p_to date,p_workspace uuid,p_bidder uuid,p_profile uuid,p_group text,p_financial boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare report jsonb;
begin
 perform private.validate_report(p_from,p_to,p_workspace,p_bidder,p_profile,p_group,p_financial);
 with events as materialized (select * from private.report_events(p_from,p_to,p_workspace,p_bidder,p_profile,true)),
 keyed as (select e.*,case p_group when 'bidder' then e.bidder_id::text when 'profile' then e.profile_id::text else e.resume_id::text end key,
  case p_group when 'bidder' then coalesce(bp.display_name,'Bidder') else coalesce(cp.identifier,'Profile') end label,
  case p_group when 'bidder' then coalesce(bp.email,'') when 'profile' then coalesce(cp.candidate_name,'Candidate') else coalesce(cp.candidate_name,'Candidate')||' · '||coalesce(bp.display_name,'Bidder') end sub
 from events e left join public.profiles bp on bp.id=e.bidder_id left join public.candidate_profiles cp on cp.id=e.profile_id),
 grouped as (select key,max(label) label,max(sub) sub,sum(n) n,sum(cents) cents,sum(tracked) applied,sum(interviews) interviews from keyed group by key),
 totals as (select coalesce(sum(n),0) n,coalesce(sum(cents),0) cents,count(distinct resume_id) resumes,coalesce(sum(retained),0) retained,coalesce(sum(tracked),0) applied,coalesce(sum(interviews),0) interviews,coalesce(sum(greatest(n-tracked,0)),0) excluded from events)
 select case when p_financial then jsonb_build_object(
 'totals',(select jsonb_build_object('count',n,'cents',cents,'resumes',resumes,'retainedCount',retained,'trackedApplications',applied,'trackedInterviews',interviews,'excludedInterviewCount',excluded) from totals),
 'groups',coalesce((select jsonb_agg(jsonb_build_object('id',key,'label',label,'sub',sub,'count',n,'cents',cents,'applied',applied,'interviews',interviews) order by cents desc,key) from grouped),'[]'::jsonb))
 else jsonb_build_object(
 'totals',(select jsonb_build_object('applied',applied,'interviews',interviews,'excludedApplications',excluded) from totals),
 'groups',coalesce((select jsonb_agg(jsonb_build_object('id',key,'label',label,'applied',applied,'interviews',interviews,'conversion',case when applied=0 then null else round(interviews*100.0/applied,1) end) order by applied desc,key) from grouped),'[]'::jsonb)) end into report;
 return report;
end $$;
create function public.earnings_performance_v2(p_from date default null,p_to date default null,p_workspace uuid default null,p_bidder uuid default null,p_profile uuid default null,p_group text default 'bidder') returns jsonb language sql stable security definer set search_path='' as $$select private.cohort_report(p_from,p_to,p_workspace,p_bidder,p_profile,p_group,true)$$;
create function public.interview_performance(p_from date default null,p_to date default null,p_workspace uuid default null,p_bidder uuid default null,p_profile uuid default null,p_group text default 'bidder') returns jsonb language sql stable security definer set search_path='' as $$select private.cohort_report(p_from,p_to,p_workspace,p_bidder,p_profile,p_group,false)$$;
revoke all on function private.validate_report(date,date,uuid,uuid,uuid,text,boolean),private.report_events(date,date,uuid,uuid,uuid,boolean),private.cohort_report(date,date,uuid,uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.dashboard_performance_v2(date,date,uuid,uuid,uuid),public.earnings_performance_v2(date,date,uuid,uuid,uuid,text),public.interview_performance(date,date,uuid,uuid,uuid,text) from public,anon;
grant execute on function public.dashboard_performance_v2(date,date,uuid,uuid,uuid),public.earnings_performance_v2(date,date,uuid,uuid,uuid,text),public.interview_performance(date,date,uuid,uuid,uuid,text) to authenticated;
