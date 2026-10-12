-- FINAL PHASE: apply only after the compatible application has deployed.
revoke select on public.bidders from public,anon,authenticated;
revoke select (default_rate_cents) on public.bidders from public,anon,authenticated;
grant select (user_id,workspace_id,archived) on public.bidders to authenticated;
revoke select on public.resumes from public,anon,authenticated;
revoke select (rate_override_cents) on public.resumes from public,anon,authenticated;
grant select (id,workspace_id,bidder_id,identifier,candidate_name,email,phone,address,links,instructions,file_id,archived,created_at,profile_id) on public.resumes to authenticated;
revoke select on public.bids from public,anon,authenticated;
revoke select (rate_cents) on public.bids from public,anon,authenticated;
grant select (id,workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,source,arrangement,job_status,applied,found_at,applied_at,first_applied_at,evidence_file_id,rejected_hashes,version,created_at,deleted_at,deleted_by,review_status,review_revision,reviewed_by,reviewed_at,review_reason,interview_scheduled,interview_at,interview_notes,interview_updated_by,interview_updated_at,interview_tracking,application_method) on public.bids to authenticated;
revoke select on public.retained_bid_daily_aggregates from public,anon,authenticated;
revoke select (earned_cents) on public.retained_bid_daily_aggregates from public,anon,authenticated;
grant select (workspace_id,profile_id,bidder_id,resume_id,report_day,metric,record_count,created_at,interview_count,interview_tracking,tracked_count) on public.retained_bid_daily_aggregates to authenticated;
revoke select on public.bid_events from public,anon,authenticated;
revoke select (details) on public.bid_events from public,anon,authenticated;
grant select (id,bid_id,actor_id,event,reason,file_id,created_at) on public.bid_events to authenticated;

create or replace function public.dashboard_performance(
 p_from date,p_to date,p_workspace uuid default null,p_bidder uuid default null,
 p_profile uuid default null,p_group text default 'profile'
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare role_name text; report jsonb;
begin
 if not exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('admin','client') and not p.archived and p.approval_status='approved') then raise exception 'Access denied'; end if;

 if auth.uid() is null then raise exception 'Access denied'; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>365 then raise exception 'Choose a reporting range of 1 to 366 days'; end if;
 if p_group not in ('profile','bidder','assignment') then raise exception 'Invalid reporting group'; end if;
 select role into role_name from public.profiles where id=auth.uid() and not archived;
 if role_name is null then raise exception 'Access denied'; end if;
 if role_name='bidder' then
  if p_bidder is not null and p_bidder<>auth.uid() then raise exception 'Access denied'; end if;
  if p_workspace is not null and not exists(select 1 from public.bidders b where b.user_id=auth.uid() and b.workspace_id=p_workspace and not b.archived) then raise exception 'Access denied'; end if;
  if p_profile is not null and not exists(select 1 from public.resumes r where r.bidder_id=auth.uid() and r.profile_id=p_profile and not r.archived) then raise exception 'Access denied'; end if;
 else
  if p_workspace is not null then perform public.require_manager(p_workspace); end if;
  if p_bidder is not null and not exists(select 1 from public.bidders b where b.user_id=p_bidder and (p_workspace is null or b.workspace_id=p_workspace) and public.manages(b.workspace_id)) then raise exception 'Access denied'; end if;
  if p_profile is not null and not exists(select 1 from public.candidate_profiles cp where cp.id=p_profile and (p_workspace is null or cp.workspace_id=p_workspace) and public.manages(cp.workspace_id)) then raise exception 'Access denied'; end if;
 end if;

 with live as materialized (
  select b.*,r.profile_id,(b.found_at at time zone 'America/Chicago')::date found_day,
   (b.applied_at at time zone 'America/Chicago')::date applied_day,
   (b.first_applied_at at time zone 'America/Chicago')::date first_day,
   coalesce(b.rate_cents,0) earned
  from public.bids b join public.resumes r on r.id=b.resume_id
  where b.deleted_at is null and public.can_read(b.workspace_id,b.bidder_id)
   and (p_workspace is null or b.workspace_id=p_workspace)
   and (p_bidder is null or b.bidder_id=p_bidder)
   and (p_profile is null or r.profile_id=p_profile)
 ), history as materialized (
  select a.* from public.retained_bid_daily_aggregates a
  where public.can_read(a.workspace_id,a.bidder_id)
   and (p_workspace is null or a.workspace_id=p_workspace)
   and (p_bidder is null or a.bidder_id=p_bidder)
   and (p_profile is null or a.profile_id=p_profile)
 ), days as (
  select d::date report_day from generate_series(p_from,p_to,interval '1 day') d
 ), found_days as (
  select found_day date_key,count(*) found_count,count(*) filter(where applied) found_applied
  from live where found_day between p_from and p_to group by found_day
 ), applied_activity as (
  select applied_day date_key,count(*) applied_count from live where applied and applied_day between p_from and p_to group by applied_day
 ), earnings as (
  select first_day date_key,count(*) earning_count,count(*) filter(where interview_scheduled)::bigint interview_count,
   sum(earned)::bigint earned_cents from live where applied and first_day between p_from and p_to group by first_day
 ), hist as (
  select report_day date_key,
   sum(record_count) filter(where metric='found')::bigint found_count,
   sum(record_count) filter(where metric='found')::bigint found_applied,
   sum(record_count) filter(where metric='applied_activity')::bigint applied_count,
   sum(record_count) filter(where metric='earning')::bigint earning_count,
   sum(earned_cents) filter(where metric='earning')::bigint earned_cents,
   sum(tracked_count) filter(where metric='earning')::bigint tracked_count,
   sum(interview_count) filter(where metric='earning')::bigint interview_count
  from history where report_day between p_from and p_to group by report_day
 ), series as (
  select d.report_day,
   coalesce(f.found_count,0)+coalesce(h.found_count,0) found_total,
   coalesce(f.found_applied,0)+coalesce(h.found_applied,0) found_applied,
   coalesce(a.applied_count,0)+coalesce(h.applied_count,0) applied,
   coalesce(e.earned_cents,0)+coalesce(h.earned_cents,0) earnings_cents,
   coalesce(e.earning_count,0)+coalesce(h.earning_count,0) earnings_count,
   coalesce(e.earning_count,0)+coalesce(h.tracked_count,0) tracked_count,
   coalesce(e.interview_count,0)+coalesce(h.interview_count,0) interview_count
  from days d left join found_days f on f.date_key=d.report_day left join applied_activity a on a.date_key=d.report_day
   left join earnings e on e.date_key=d.report_day left join hist h on h.date_key=d.report_day
 ), review as (
  select count(*) filter(where review_status='pending')::bigint pending,
   count(*) filter(where review_status='approved' and not applied)::bigint approved_unapplied,
   count(*) filter(where review_status='rejected')::bigint rejected
  from live where deleted_at is null
 ), sources as (
  select coalesce(nullif(trim(source),''),'Other') label,count(*)::bigint value from live
  where found_day between p_from and p_to group by 1 order by 2 desc limit 10
 ), live_groups as (
  select case p_group when 'profile' then l.profile_id::text when 'bidder' then l.bidder_id::text else l.profile_id::text||':'||l.bidder_id::text end key,
   l.profile_id,l.bidder_id,count(*)::bigint applied_count,
   count(*) filter(where l.interview_scheduled)::bigint interviews,0::bigint historical_count,0::bigint historical_interviews
  from live l where l.applied and l.first_day between p_from and p_to group by 1,2,3
 ), retained_groups as (
  select case p_group when 'profile' then h.profile_id::text when 'bidder' then h.bidder_id::text else h.profile_id::text||':'||h.bidder_id::text end key,
   h.profile_id,h.bidder_id,0::bigint applied_count,0::bigint interviews,
   sum(h.tracked_count)::bigint historical_count,sum(h.interview_count)::bigint historical_interviews
  from history h where h.metric='earning' and h.report_day between p_from and p_to and h.tracked_count>0 group by 1,2,3
 ), groups_union as (
  select * from live_groups union all select * from retained_groups
 ), groups_final as (
  select g.key,g.profile_id,g.bidder_id,sum(g.applied_count+g.historical_count)::bigint applied,
   sum(g.interviews+g.historical_interviews)::bigint interviews,
   case p_group when 'profile' then cp.identifier when 'bidder' then bp.display_name else cp.identifier||' · '||bp.display_name end label
  from groups_union g left join public.candidate_profiles cp on cp.id=g.profile_id
   left join public.profiles bp on bp.id=g.bidder_id group by g.key,g.profile_id,g.bidder_id,cp.identifier,bp.display_name
 )
 select jsonb_build_object(
  'daily',coalesce((select jsonb_agg(jsonb_build_object('date',s.report_day,'found',s.found_total,'foundApplied',s.found_applied,'applied',s.applied,'earningsCents',s.earnings_cents,'earningsCount',s.earnings_count) order by s.report_day) from series s),'[]'),
  'totals',(select jsonb_build_object('found',coalesce(sum(s.found_total),0),'foundApplied',coalesce(sum(s.found_applied),0),'appliedActivity',coalesce(sum(s.applied),0),'earningsCents',coalesce(sum(s.earnings_cents),0),'earningsCount',coalesce(sum(s.earnings_count),0),'trackedApplications',coalesce(sum(s.tracked_count),0),'trackedInterviews',coalesce(sum(s.interview_count),0)) from series s),
  'review',(select to_jsonb(review) from review),
  'sources',coalesce((select jsonb_agg(jsonb_build_object('label',label,'value',value)) from sources),'[]'),
  'groups',coalesce((select jsonb_agg(jsonb_build_object('key',key,'label',label,'applied',applied,'interviews',interviews,'conversion',case when applied=0 then null else round(interviews::numeric*100/applied,1) end) order by applied desc,label) from groups_final),'[]')
 ) into report;
 return report;
end $$;

create or replace function public.earnings_performance(
  p_from date default null,p_to date default null,p_workspace uuid default null,
  p_bidder uuid default null,p_profile uuid default null,p_group text default 'bidder'
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare role_name text; report jsonb;
begin
 if not exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('admin','client') and not p.archived and p.approval_status='approved') then raise exception 'Access denied'; end if;

  if auth.uid() is null then raise exception 'Access denied'; end if;
  if p_group not in ('profile','bidder','assignment') then raise exception 'Invalid reporting group'; end if;
  if p_from is not null and p_to is not null and p_to<p_from then raise exception 'Choose a valid date range'; end if;
  select role into role_name from public.profiles where id=auth.uid() and not archived;
  if role_name is null then raise exception 'Access denied'; end if;
  if role_name='bidder' then
    if (p_bidder is not null and p_bidder<>auth.uid()) or (p_workspace is not null and not exists(select 1 from public.bidders b where b.user_id=auth.uid() and b.workspace_id=p_workspace and not b.archived)) then raise exception 'Access denied'; end if;
    if p_profile is not null and not exists(select 1 from public.resumes r where r.bidder_id=auth.uid() and r.profile_id=p_profile and not r.archived) then raise exception 'Access denied'; end if;
  else
    if p_workspace is not null then perform public.require_manager(p_workspace); end if;
    if p_bidder is not null and not exists(select 1 from public.bidders b where b.user_id=p_bidder and (p_workspace is null or b.workspace_id=p_workspace) and public.manages(b.workspace_id)) then raise exception 'Access denied'; end if;
    if p_profile is not null and not exists(select 1 from public.candidate_profiles cp where cp.id=p_profile and (p_workspace is null or cp.workspace_id=p_workspace) and public.manages(cp.workspace_id)) then raise exception 'Access denied'; end if;
  end if;
  with live as materialized (
    select b.id bid_id,b.bidder_id,r.id resume_id,r.profile_id,b.interview_scheduled,coalesce(b.rate_cents,0)::bigint cents,
      (b.first_applied_at at time zone 'America/Chicago')::date report_day
    from public.bids b join public.resumes r on r.id=b.resume_id
    where b.applied and b.deleted_at is null and b.first_applied_at is not null
      and public.can_read(b.workspace_id,b.bidder_id)
      and (p_workspace is null or b.workspace_id=p_workspace)
      and (p_bidder is null or b.bidder_id=p_bidder)
      and (p_profile is null or r.profile_id=p_profile)
      and (p_from is null or (b.first_applied_at at time zone 'America/Chicago')::date>=p_from)
      and (p_to is null or (b.first_applied_at at time zone 'America/Chicago')::date<=p_to)
  ), history as materialized (
    select a.* from public.retained_bid_daily_aggregates a
    where a.metric='earning' and public.can_read(a.workspace_id,a.bidder_id)
      and (p_workspace is null or a.workspace_id=p_workspace)
      and (p_bidder is null or a.bidder_id=p_bidder)
      and (p_profile is null or a.profile_id=p_profile)
      and (p_from is null or a.report_day>=p_from)
      and (p_to is null or a.report_day<=p_to)
  ), groups as (
    select case p_group when 'profile' then l.profile_id::text when 'bidder' then l.bidder_id::text else l.resume_id::text end key,
      l.bidder_id,l.resume_id,l.profile_id,count(*)::bigint app_count,sum(l.cents)::bigint earned_cents,
      count(*) filter(where l.interview_scheduled)::bigint interviews,count(*)::bigint tracked_count,0::bigint retained_count,0::bigint retained_tracked
    from live l
    group by 1,2,3,4
    union all
    select case p_group when 'profile' then h.profile_id::text when 'bidder' then h.bidder_id::text else h.resume_id::text end key,
      h.bidder_id,h.resume_id,h.profile_id,0::bigint,0::bigint,0::bigint,0::bigint,sum(h.record_count)::bigint,sum(h.tracked_count)::bigint
    from history h group by 1,2,3,4
  ), grouped as (
    select g.key,sum(g.app_count+g.retained_count)::bigint app_count,
      sum(g.earned_cents)::bigint earned_cents,
      sum(g.interviews)::bigint interviews,sum(g.tracked_count+g.retained_tracked)::bigint tracked_count,
      max(case p_group when 'bidder' then coalesce(bp.display_name,'Bidder') else coalesce(cp.identifier,'Profile') end) label,
      max(case p_group when 'bidder' then coalesce(bp.email,'') when 'profile' then coalesce(cp.candidate_name,'Candidate') else coalesce(cp.candidate_name,'Candidate')||' · '||coalesce(bp.display_name,'Bidder') end) sub
    from groups g left join public.profiles bp on bp.id=g.bidder_id
      left join public.candidate_profiles cp on cp.id=g.profile_id
    group by g.key
  ), live_totals as (
    select count(*)::bigint app_count,coalesce(sum(cents),0)::bigint earned_cents,
      count(distinct resume_id)::bigint resume_count,count(*)::bigint tracked_count,
      count(*) filter(where l.interview_scheduled)::bigint interview_count
    from live l
  ), history_totals as (
    select coalesce(sum(record_count),0)::bigint app_count,coalesce(sum(earned_cents),0)::bigint earned_cents,
      count(distinct resume_id)::bigint resume_count,coalesce(sum(tracked_count),0)::bigint tracked_count,
      coalesce(sum(interview_count),0)::bigint interview_count,coalesce(sum(greatest(record_count-tracked_count,0)),0)::bigint excluded_count
    from history
  ), resume_union as (
    select resume_id from live union select resume_id from history where record_count>0
  )
  select jsonb_build_object(
    'totals',(select jsonb_build_object('count',l.app_count+h.app_count,'cents',l.earned_cents+h.earned_cents,'resumes',(select count(distinct resume_id) from resume_union),'retainedCount',h.app_count,'trackedApplications',l.tracked_count+h.tracked_count,'trackedInterviews',l.interview_count+h.interview_count,'excludedInterviewCount',h.excluded_count) from live_totals l cross join history_totals h),
    'groups',coalesce((select jsonb_agg(jsonb_build_object('id',key,'label',label,'sub',sub,'count',app_count,'cents',earned_cents,'applied',tracked_count,'interviews',interviews) order by earned_cents desc,label) from grouped),'[]'::jsonb)
  ) into report;
  return report;
end $$;

create or replace function public.retained_aggregate_summary(p_from date default null,p_to date default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; begin
 if not exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('admin','client') and not p.archived and p.approval_status='approved') then raise exception 'Access denied'; end if;

 select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) into result
 from public.retained_bid_daily_aggregates a
 where (p_from is null or a.report_day>=p_from) and (p_to is null or a.report_day<=p_to)
  and public.can_read(a.workspace_id,a.bidder_id);
 return result;
end $$;

-- Retire the whole-row legacy projection only after compatible callers deploy.
create or replace function public.list_bids(p_query jsonb) returns jsonb
language sql stable security invoker set search_path='' as $$
 select public.list_bids_v2(p_query)
$$;
revoke all on function public.list_bids(jsonb) from public,anon;
grant execute on function public.list_bids(jsonb) to authenticated;
