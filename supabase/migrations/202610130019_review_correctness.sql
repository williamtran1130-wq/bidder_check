-- Forward correction for review findings L-01/L-02/O-01/O-02.
-- Preserve all public signatures, response shapes, reporting snapshots and
-- established profile-before-bid lock ordering from the 49-migration baseline.

create or replace function public.process_candidate_retention(p_limit integer default 500) returns jsonb language plpgsql security definer set search_path='' as $$
declare profile record; current_profile public.candidate_profiles; bid record; cutoff timestamptz; batch_limit integer=least(greatest(coalesce(p_limit,500),1),2000); deleted_total integer=0; storage_count integer=0; queued integer; found_day date; applied_day date; earned_day date; begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 for profile in select id from public.candidate_profiles where retention_months is not null order by id loop
  exit when deleted_total>=batch_limit;
  perform pg_advisory_xact_lock(hashtextextended(profile.id::text,0));
  -- The cursor may have waited behind a committed policy edit. Reread only
  -- after the shared profile lock, before acquiring any bid row locks.
  select * into current_profile from public.candidate_profiles cp where cp.id=profile.id for update;
  if current_profile.id is null or current_profile.retention_months is null then continue; end if;
  cutoff=public.candidate_retention_cutoff(clock_timestamp(),current_profile.retention_months);
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

create or replace function public.manual_apply_bids(
  p_targets jsonb,
  p_applied_at timestamptz,
  p_reason text,
  p_request uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid=auth.uid();
  target_count integer;
  unique_count integer;
  fingerprint text;
  prior public.manual_application_receipts;
  b public.bids;
  target jsonb;
  profile_id uuid;
  rate integer;
  applied_count integer=0;
  unchanged_count integer=0;
  actual_stamp timestamptz=clock_timestamp();
  outcome jsonb;
begin
  if actor is null then raise exception 'Sign in to apply bids'; end if;
  if not exists (
    select 1 from public.profiles p
    where p.id=actor and p.role in ('admin','client') and not p.archived
      and (p.role='admin' or p.approval_status='approved')
  ) then raise exception 'Only active clients and admins can manually apply bids'; end if;
  if jsonb_typeof(p_targets) is distinct from 'array' then raise exception 'Select bids to apply'; end if;
  target_count=jsonb_array_length(p_targets);
  if target_count<1 or target_count>500 then raise exception 'Select between 1 and 500 bids'; end if;
  if length(trim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'A reason is required (up to 1000 characters)'; end if;
  if p_request is null then raise exception 'A request id is required'; end if;
  if p_applied_at is null or p_applied_at>actual_stamp then raise exception 'Applied time cannot be in the future'; end if;

  select count(distinct value->>'id') into unique_count from jsonb_array_elements(p_targets);
  if unique_count<>target_count then raise exception 'A bid was selected more than once'; end if;
  fingerprint=md5(jsonb_build_object(
    'targets',(select jsonb_agg(value order by value->>'id') from jsonb_array_elements(p_targets)),
    'applied_at',p_applied_at,'reason',trim(p_reason)
  )::text);
  -- Serialize receipt lookup with this actor/request, independently of which
  -- profiles are selected. Current actor authorization above still gates replay.
  perform pg_advisory_xact_lock(hashtextextended('manual-application:'||actor::text||':'||p_request::text,0));
  select * into prior from public.manual_application_receipts where actor_id=actor and request_id=p_request;
  if prior.actor_id is not null then
    if prior.fingerprint<>fingerprint then raise exception 'This request id was already used for different content'; end if;
    return prior.result;
  end if;

  -- Use the profile lock shared by imports, edits, reviews, and retention.
  for profile_id in
    select distinct r.profile_id
    from jsonb_array_elements(p_targets) t
    join public.bids x on x.id=(t.value->>'id')::uuid
    join public.resumes r on r.id=x.resume_id
    order by r.profile_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(profile_id::text,0));
  end loop;

  -- Lock bids in a stable order after profile locks, matching the established
  -- profile-then-bid lock order used by review, imports, and retention.
  perform 1 from public.bids x
  join jsonb_array_elements(p_targets) t on x.id=(t.value->>'id')::uuid
  order by x.id for update of x;

  for target in select value from jsonb_array_elements(p_targets) loop
    if coalesce(target->>'version','') !~ '^[0-9]+$' then raise exception 'Selected bids changed. Refresh and try again'; end if;
    select * into b from public.bids where id=(target->>'id')::uuid;
    if b.id is null or not public.manages(b.workspace_id) then raise exception 'A selected bid is unavailable'; end if;
    if b.version<>(target->>'version')::integer then raise exception 'A selected bid changed. Refresh and try again'; end if;
    if b.deleted_at is not null then raise exception 'Restore selected bids from trash before applying'; end if;
    if p_applied_at<b.found_at then raise exception 'Applied time cannot be earlier than a bid’s Found time'; end if;
    if b.first_applied_at is not null and p_applied_at<b.first_applied_at then raise exception 'Reapplication cannot precede the first application time'; end if;
    if not b.applied then
      select coalesce(b.rate_cents,r.rate_override_cents,m.default_rate_cents) into rate
      from public.resumes r join public.bidders m on m.user_id=r.bidder_id
      where r.id=b.resume_id and r.bidder_id=b.bidder_id and r.workspace_id=b.workspace_id;
      if rate is null then raise exception 'Configure a rate before manually applying every selected bid'; end if;
      update public.bids set applied=true,application_method='manual',evidence_file_id=null,
        rate_cents=coalesce(rate_cents,rate),applied_at=p_applied_at,
        first_applied_at=coalesce(first_applied_at,p_applied_at),review_status='approved',
        review_revision=review_revision+1,reviewed_by=actor,reviewed_at=actual_stamp,
        review_reason=null,version=version+1
      where id=b.id returning * into b;
      insert into public.bid_events(bid_id,actor_id,event,reason,details)
      values(b.id,actor,'application_manual',left(trim(p_reason),1000),jsonb_build_object(
        'applied_at',p_applied_at,'operation_at',actual_stamp,'application_method','manual',
        'review_revision',b.review_revision
      ));
      applied_count=applied_count+1;
    else
      unchanged_count=unchanged_count+1;
    end if;
  end loop;

  outcome=jsonb_build_object('applied',applied_count,'unchanged',unchanged_count);
  insert into public.manual_application_receipts(actor_id,request_id,fingerprint,result)
  values(actor,p_request,fingerprint,outcome);
  return outcome;
end $$;

revoke all on function public.manual_apply_bids(jsonb,timestamptz,text,uuid) from public,anon;
grant execute on function public.manual_apply_bids(jsonb,timestamptz,text,uuid) to authenticated;

-- Restate the exact intended final assignment definition, including the later
-- bidder-change file-clearing rule. Keep guard_resume_assignment_file intact.
create or replace function public.save_resume_assignment(
 p_id uuid,p_profile uuid,p_bidder uuid,p_email text,p_phone text,p_file uuid,p_rate integer
) returns uuid language plpgsql security definer set search_path='' as $$
declare p public.candidate_profiles; b public.bidders; result uuid; current_row public.resumes; begin
 select * into p from public.candidate_profiles where id=p_profile and not archived;
 if p.id is null then raise exception 'Choose an active profile'; end if;
 perform public.require_manager(p.workspace_id);
 select * into b from public.bidders where user_id=p_bidder and workspace_id=p.workspace_id and not archived;
 if b.user_id is null then raise exception 'Choose an active bidder in this workspace'; end if;
 if p_rate is not null and p_rate not between 0 and 100000000 then raise exception 'Rate is invalid'; end if;
 if length(trim(coalesce(p_email,'')))=0 or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(trim(coalesce(p_phone,'')))=0 then
  raise exception 'Assignment email and phone are required';
 end if;
 if p_file is not null and (p_id is null or not exists(select 1 from public.files f where f.id=p_file and f.kind='resume' and f.finalized and f.workspace_id=p.workspace_id and f.bidder_id=p_bidder and f.resume_id=p_id)) then
  raise exception 'Choose a verified PDF assigned to this bidder';
 end if;
 if p_id is null then
  insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name,email,phone,address,links,instructions,file_id,rate_override_cents)
   values(p.workspace_id,p_bidder,p.id,p.identifier,p.candidate_name,lower(trim(p_email)),trim(p_phone),p.address,p.links,p.instructions,p_file,p_rate) returning id into result;
 else
  select * into current_row from public.resumes where id=p_id for update;
  if current_row.id is null or current_row.workspace_id<>p.workspace_id then raise exception 'Assignment not found'; end if;
  if (current_row.profile_id<>p.id or current_row.bidder_id<>p_bidder) and exists(select 1 from public.bids where resume_id=p_id) then
   raise exception 'An assignment with bid history cannot be moved';
  end if;
  update public.resumes set profile_id=p.id,bidder_id=p_bidder,identifier=p.identifier,candidate_name=p.candidate_name,
   email=lower(trim(p_email)),phone=trim(p_phone),address=p.address,links=p.links,instructions=p.instructions,
   file_id=case when current_row.bidder_id is distinct from p_bidder then p_file else coalesce(p_file,file_id) end,rate_override_cents=p_rate,archived=false where id=p_id returning id into result;
 end if;
 return result;
end $$;

-- Target only the five observed effective-grant differences. Parent SECURITY
-- DEFINER RPCs retain access to their internal helper through the function owner.
revoke all on function public.candidate_bid_issues(uuid,uuid,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.finish_push_attempt(uuid,uuid,text,boolean),
 public.message_occurrence_at(date,time),
 public.next_message_occurrence(timestamptz,time,smallint[],boolean),
 public.process_due_messages(timestamptz,integer) from public,anon,authenticated;
grant execute on function public.finish_push_attempt(uuid,uuid,text,boolean),
 public.message_occurrence_at(date,time),
 public.next_message_occurrence(timestamptz,time,smallint[],boolean),
 public.process_due_messages(timestamptz,integer) to service_role;
