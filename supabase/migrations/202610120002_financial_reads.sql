-- Compatibility phase: deploy this before application safe projections; enforce privileges last.
create or replace function public.manager_financial_values(p_bidder_ids uuid[] default '{}',p_resume_ids uuid[] default '{}',p_bid_ids uuid[] default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare bidder_ids uuid[]=coalesce(p_bidder_ids,'{}'); resume_ids uuid[]=coalesce(p_resume_ids,'{}'); bid_ids uuid[]=coalesce(p_bid_ids,'{}');
begin
 if not exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('admin','client') and not p.archived and p.approval_status='approved') then raise exception 'Access denied'; end if;
 if cardinality(bidder_ids)+cardinality(resume_ids)+cardinality(bid_ids)>1000 then raise exception 'Maximum 1000 requested IDs'; end if;
 if exists(select 1 from unnest(bidder_ids) requested(id) where not exists(select 1 from public.bidders b where b.user_id=requested.id and public.manages(b.workspace_id)))
 or exists(select 1 from unnest(resume_ids) requested(id) where not exists(select 1 from public.resumes r where r.id=requested.id and public.manages(r.workspace_id)))
 or exists(select 1 from unnest(bid_ids) requested(id) where not exists(select 1 from public.bids b where b.id=requested.id and public.manages(b.workspace_id))) then raise exception 'Access denied'; end if;
 return jsonb_build_object(
 'bidders',coalesce((select jsonb_object_agg(b.user_id,b.default_rate_cents) from public.bidders b where b.user_id=any(bidder_ids) and public.manages(b.workspace_id)),'{}'::jsonb),
 'resumes',coalesce((select jsonb_object_agg(r.id,r.rate_override_cents) from public.resumes r where r.id=any(resume_ids) and public.manages(r.workspace_id)),'{}'::jsonb),
 'bids',coalesce((select jsonb_object_agg(b.id,b.rate_cents) from public.bids b where b.id=any(bid_ids) and public.manages(b.workspace_id)),'{}'::jsonb));
end $$;
revoke all on function public.manager_financial_values(uuid[],uuid[],uuid[]) from public,anon;
grant execute on function public.manager_financial_values(uuid[],uuid[],uuid[]) to authenticated,service_role;

create or replace function public.list_bids_v2(p_query jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare
  page_index integer=greatest(0,least(100000,coalesce((p_query->>'pageIndex')::integer,0)));
  page_size integer=greatest(1,least(100,coalesce((p_query->>'pageSize')::integer,10)));
  sort_id text=coalesce(p_query->'sorting'->0->>'id','found_at');
  sort_desc boolean=coalesce((p_query->'sorting'->0->>'desc')::boolean,true);
  columns jsonb=coalesce(p_query->'columnFilters','{}'::jsonb);
  bidder_filter text=coalesce(p_query->'columnFilters'->>'bidder_id','');
  resume_filter text=coalesce(p_query->'columnFilters'->>'resume_id','');
  bidder_matches uuid[];
  resume_matches uuid[];
  result jsonb;
begin
  if sort_id not in ('found_at','resume_id','company','role_name','url','bidder_id','source','applied','applied_at','arrangement','job_status','review_status','interview_scheduled','screenshot') then sort_id='found_at'; end if;

  -- Resolve display-name filters once against the small account/library tables;
  -- the application-history scan then compares UUIDs without per-row joins.
  if bidder_filter<>'' then
    select coalesce(array_agg(p.id),'{}'::uuid[]) into bidder_matches
    from public.profiles p
    where position(lower(bidder_filter) in lower(p.id::text||' '||coalesce(p.display_name,'')))>0;
  end if;
  if resume_filter<>'' then
    select coalesce(array_agg(r.id),'{}'::uuid[]) into resume_matches
    from public.resumes r
    join public.candidate_profiles cp on cp.id=r.profile_id
    where position(lower(resume_filter) in lower(coalesce(cp.identifier,'')||' '||coalesce(cp.candidate_name,'')||' '||coalesce(r.email,'')))>0;
  end if;

  with filtered as materialized (
    select b.id,b.found_at,b.resume_id,b.company,b.role_name,b.url,b.bidder_id,b.source,
      b.applied,b.applied_at,b.arrangement,b.job_status,b.review_status,
      b.interview_scheduled,b.evidence_file_id
    from public.bids b
    where ((coalesce((p_query->>'trash')::boolean,false) and b.deleted_at is not null) or
           (not coalesce((p_query->>'trash')::boolean,false) and b.deleted_at is null))
      and (nullif(p_query->>'scopeBidderId','') is null or b.bidder_id=(p_query->>'scopeBidderId')::uuid)
      and (nullif(p_query->>'bidder','') is null or p_query->>'bidder'='all' or b.bidder_id=(p_query->>'bidder')::uuid)
      and (nullif(p_query->>'resume','') is null or p_query->>'resume'='all' or b.resume_id=(p_query->>'resume')::uuid)
      and (nullif(p_query->>'source','') is null or p_query->>'source'='all' or b.source=p_query->>'source')
      and (nullif(p_query->>'arrangement','') is null or p_query->>'arrangement'='all' or b.arrangement=p_query->>'arrangement')
      and (nullif(p_query->>'job','') is null or p_query->>'job'='all' or b.job_status=p_query->>'job')
      and (nullif(p_query->>'rangeFrom','') is null or b.found_at >= (p_query->>'rangeFrom')::timestamptz)
      and (nullif(p_query->>'rangeTo','') is null or b.found_at < (p_query->>'rangeTo')::timestamptz)
      and (coalesce(p_query->>'search','')='' or position(lower(p_query->>'search') in lower(b.company||' '||b.role_name||' '||b.url))>0)
      and (coalesce(columns->>'company','')='' or position(lower(columns->>'company') in lower(b.company))>0)
      and (coalesce(columns->>'role_name','')='' or position(lower(columns->>'role_name') in lower(b.role_name))>0)
      and (coalesce(columns->>'url','')='' or position(lower(columns->>'url') in lower(b.url))>0)
      and (coalesce(columns->>'source','')='' or position(lower(columns->>'source') in lower(b.source))>0)
      and (bidder_filter='' or b.bidder_id=any(bidder_matches))
      and (resume_filter='' or b.resume_id=any(resume_matches))
      and (coalesce(columns->>'applied','')='' or b.applied=(columns->>'applied'='Applied'))
      and (coalesce(columns->>'review_status','')='' or b.review_status=columns->>'review_status')
      and (coalesce(columns->>'interview_scheduled','')='' or b.interview_scheduled=(columns->>'interview_scheduled'='Scheduled'))
      and (coalesce(columns->>'arrangement','')='' or b.arrangement=columns->>'arrangement')
      and (coalesce(columns->>'job_status','')='' or b.job_status=columns->>'job_status')
      and (coalesce(columns->>'screenshot','')='' or (b.evidence_file_id is not null)=(columns->>'screenshot'='Has screenshot'))
      and (not (columns ? 'found_at') or (
        coalesce(columns->'found_at'->>'presence','all')<>'empty' and
        (nullif(columns->'found_at'->>'from','') is null or (b.found_at at time zone 'America/Chicago')::date >= (columns->'found_at'->>'from')::date) and
        (nullif(columns->'found_at'->>'to','') is null or (b.found_at at time zone 'America/Chicago')::date <= (columns->'found_at'->>'to')::date)))
      and (not (columns ? 'applied_at') or (
        (coalesce(columns->'applied_at'->>'presence','all')<>'empty' or b.applied_at is null) and
        (coalesce(columns->'applied_at'->>'presence','all')<>'has' or b.applied_at is not null) and
        (nullif(columns->'applied_at'->>'from','') is null or (b.applied_at at time zone 'America/Chicago')::date >= (columns->'applied_at'->>'from')::date) and
        (nullif(columns->'applied_at'->>'to','') is null or (b.applied_at at time zone 'America/Chicago')::date <= (columns->'applied_at'->>'to')::date))
      )
  ), status_filtered as materialized (
    select f.* from filtered f where coalesce(p_query->>'status','all')='all' or
      (p_query->>'status'='pending_review' and f.review_status='pending') or
      (p_query->>'status'='applied' and f.applied) or
      (p_query->>'status'='unapplied' and not f.applied)
  ), total as (select count(*)::integer as n from status_filtered),
  status_counts as (
    select count(*)::integer all_count,count(*) filter(where f.applied)::integer applied_count,
      count(*) filter(where not f.applied)::integer unapplied_count,
      count(*) filter(where f.review_status='pending')::integer pending_count from filtered f
  ), sorted as (
    select f.id,row_number() over(order by
      case when sort_id='found_at' and not sort_desc then f.found_at end asc,
      case when sort_id='found_at' and sort_desc then f.found_at end desc,
      case when sort_id='resume_id' and not sort_desc then f.resume_id::text end asc,
      case when sort_id='resume_id' and sort_desc then f.resume_id::text end desc,
      case when sort_id='company' and not sort_desc then f.company end asc,
      case when sort_id='company' and sort_desc then f.company end desc,
      case when sort_id='role_name' and not sort_desc then f.role_name end asc,
      case when sort_id='role_name' and sort_desc then f.role_name end desc,
      case when sort_id='url' and not sort_desc then f.url end asc,
      case when sort_id='url' and sort_desc then f.url end desc,
      case when sort_id='bidder_id' and not sort_desc then f.bidder_id::text end asc,
      case when sort_id='bidder_id' and sort_desc then f.bidder_id::text end desc,
      case when sort_id='source' and not sort_desc then f.source end asc,
      case when sort_id='source' and sort_desc then f.source end desc,
      case when sort_id='applied' and not sort_desc then f.applied end asc,
      case when sort_id='applied' and sort_desc then f.applied end desc,
      case when sort_id='applied_at' and not sort_desc then f.applied_at end asc nulls last,
      case when sort_id='applied_at' and sort_desc then f.applied_at end desc nulls last,
      case when sort_id='arrangement' and not sort_desc then f.arrangement end asc,
      case when sort_id='arrangement' and sort_desc then f.arrangement end desc,
      case when sort_id='job_status' and not sort_desc then f.job_status end asc,
      case when sort_id='job_status' and sort_desc then f.job_status end desc,
      case when sort_id='review_status' and not sort_desc then f.review_status end asc,
      case when sort_id='review_status' and sort_desc then f.review_status end desc,
      case when sort_id='interview_scheduled' and not sort_desc then f.interview_scheduled end asc,
      case when sort_id='interview_scheduled' and sort_desc then f.interview_scheduled end desc,
      case when sort_id='screenshot' and not sort_desc then (f.evidence_file_id is not null) end asc,
      case when sort_id='screenshot' and sort_desc then (f.evidence_file_id is not null) end desc,
      f.found_at desc,f.id asc) as row_number
    from status_filtered f
  ), page as (
    select id,row_number from sorted
    where row_number>page_index*page_size and row_number<=page_index*page_size+page_size
  ), sources as (
    select coalesce(jsonb_agg(source order by source),'[]'::jsonb) as values
    from (select distinct b.source from public.bids b
      where b.source<>'' and (nullif(p_query->>'scopeBidderId','') is null or b.bidder_id=(p_query->>'scopeBidderId')::uuid)) q
  )
  select jsonb_build_object(
    'rows',coalesce((select jsonb_agg(to_jsonb(b) order by page.row_number) from page join (select b.id,b.workspace_id,b.bidder_id,b.resume_id,b.company,b.role_name,b.url,b.normalized_url,b.source,b.arrangement,b.job_status,b.applied,b.found_at,b.applied_at,b.first_applied_at,b.evidence_file_id,b.rejected_hashes,b.version,b.created_at,b.deleted_at,b.deleted_by,b.review_status,b.review_revision,b.reviewed_by,b.reviewed_at,b.review_reason,b.interview_scheduled,b.interview_at,b.interview_notes,b.interview_updated_by,b.interview_updated_at,b.interview_tracking,b.application_method from public.bids b) b on b.id=page.id), '[]'::jsonb),
    'total',(select n from total),
    'sources',(select values from sources),
    'statusCounts',(select jsonb_build_object('all',all_count,'applied',applied_count,'unapplied',unapplied_count,'pending_review',pending_count) from status_counts)
  ) into result;
  return result;
end $$;

revoke all on function public.list_bids_v2(jsonb) from public, anon;
grant execute on function public.list_bids_v2(jsonb) to authenticated;

create or replace function public.update_bid_cell(p_bid uuid,p_field text,p_value text,p_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 b public.bids; updated public.bids; r public.resumes; initial_bid public.bids;
 value text=trim(p_value); normalized text; issues jsonb; company_value text;
 role_value text; url_value text; requested_resume uuid; profile uuid;
begin
 -- The unlocked read only discovers which shared profile must be serialized.
 select * into initial_bid from public.bids where id=p_bid;
 if initial_bid.id is null or not public.can_read(initial_bid.workspace_id,initial_bid.bidder_id) then raise exception 'Access denied'; end if;
 if p_field is null or p_field not in ('company','role_name','url','source','arrangement','job_status','resume_id') then raise exception 'Field is not editable'; end if;

 if p_field='resume_id' then
  begin requested_resume=value::uuid; exception when others then raise exception 'Choose an active resume assigned to this bidder'; end;
 else
  requested_resume=initial_bid.resume_id;
 end if;
 select * into r from public.resumes where id=requested_resume;
 if r.id is null or r.profile_id is null or r.workspace_id<>initial_bid.workspace_id or r.bidder_id<>initial_bid.bidder_id or r.archived then raise exception 'Choose an active resume assigned to this bidder'; end if;
 profile=r.profile_id;
 perform pg_advisory_xact_lock(hashtextextended(profile::text,0));

 -- Writers for one bid now all acquire the profile lock, then the row lock.
 select * into b from public.bids where id=p_bid for update;
 if b.id is null or not public.can_read(b.workspace_id,b.bidder_id) then raise exception 'Access denied'; end if;
 if b.deleted_at is not null then raise exception 'Restore this bid from trash before editing'; end if;
 if p_version is null or b.version<>p_version then return jsonb_build_object('conflict',true,'row',case when public.manages(b.workspace_id) then to_jsonb(b) else to_jsonb(b)-'rate_cents' end); end if;
 if b.resume_id<>initial_bid.resume_id then return jsonb_build_object('conflict',true,'row',case when public.manages(b.workspace_id) then to_jsonb(b) else to_jsonb(b)-'rate_cents' end); end if;
 if b.workspace_id<>r.workspace_id or b.bidder_id<>r.bidder_id then raise exception 'Access denied'; end if;
 if value is null then raise exception 'A value is required'; end if;
 if p_field in ('company','role_name') and length(value) not between 1 and 200 then raise exception 'Required; maximum 200 characters'; end if;
 if p_field='source' and length(value)>200 then raise exception 'Maximum 200 characters'; end if;
 if p_field='arrangement' and value not in ('remote','onsite','hybrid') then raise exception 'Choose remote, onsite or hybrid'; end if;
 if p_field='job_status' and value not in ('open','closed') then raise exception 'Choose open or closed'; end if;

 company_value=case when p_field='company' then value else b.company end;
 role_value=case when p_field='role_name' then value else b.role_name end;
 url_value=case when p_field='url' then value else b.url end;
 normalized=public.normalize_job_url(url_value);
 if r.id<>b.resume_id and b.first_applied_at is not null then raise exception 'Resume is locked after first application'; end if;
 issues=case when p_field in ('company','role_name','url','resume_id') then public.candidate_bid_issues(r.profile_id,b.id,company_value,role_value,url_value) else '[]'::jsonb end;
 if jsonb_array_length(issues)>0 then raise exception '%',issues->0->>'message'; end if;
 if not exists(select 1 from public.files f where f.id=r.file_id and f.kind='resume' and f.finalized and f.mime='application/pdf') then raise exception 'Upload and verify a PDF resume before adding bids'; end if;
 update public.bids set company=company_value,role_name=role_value,url=url_value,normalized_url=normalized,source=case when p_field='source' then value else source end,arrangement=case when p_field='arrangement' then value else arrangement end,job_status=case when p_field='job_status' then value else job_status end,resume_id=case when p_field='resume_id' then r.id else resume_id end,version=version+1 where id=b.id returning * into updated;
 insert into public.bid_events(bid_id,actor_id,event,details) values(b.id,auth.uid(),'edited',jsonb_build_object('field',p_field,'before',to_jsonb(b),'after',to_jsonb(updated)));
 return jsonb_build_object('ok',true,'row',case when public.manages(updated.workspace_id) then to_jsonb(updated) else to_jsonb(updated)-'rate_cents' end);
end $$;

create or replace function public.resubmit_bid(p_bid uuid,p_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.bids; begin
 select * into b from public.bids where id=p_bid for update;
 if b.id is null or b.bidder_id<>auth.uid() or not public.can_read(b.workspace_id,b.bidder_id) then raise exception 'Access denied'; end if;
 if b.version<>p_version then return jsonb_build_object('conflict',true,'row',case when public.manages(b.workspace_id) then to_jsonb(b) else to_jsonb(b)-'rate_cents' end); end if;
 if b.deleted_at is not null or b.applied or b.review_status<>'rejected' then raise exception 'Only an active rejected bid can be resubmitted'; end if;
 update public.bids set review_status='pending',review_revision=review_revision+1,reviewed_by=null,reviewed_at=null,review_reason=null,version=version+1 where id=b.id returning * into b;
 insert into public.bid_events(bid_id,actor_id,event) values(b.id,auth.uid(),'review_resubmitted');
 return jsonb_build_object('conflict',false,'row',case when public.manages(b.workspace_id) then to_jsonb(b) else to_jsonb(b)-'rate_cents' end);
end $$;
