-- Count total and status groups in one pass over the filtered snapshot.
-- Join evidence before pagination only when sorting by its size; retain the same
-- materialized evidence/count snapshot for authorized page output.
create or replace function public.list_bids_v2(p_query jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' set plan_cache_mode=force_custom_plan as $$
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
  can_view_sizes boolean;
  result jsonb;
begin
  select exists(select 1 from public.profiles p where p.id=auth.uid()
    and p.role in ('admin','client') and not p.archived and p.approval_status='approved')
    into can_view_sizes;

  if (sort_id='screenshot_size_bytes' and not can_view_sizes) or sort_id not in ('found_at','resume_id','company','role_name','url','bidder_id','source','applied','applied_at','arrangement','job_status','review_status','interview_scheduled','screenshot','screenshot_size_bytes') then sort_id='found_at'; end if;

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
    select b.id,b.workspace_id,b.found_at,
      case when sort_id='resume_id' then b.resume_id end as resume_id,
      case when sort_id='company' then b.company end as company,
      case when sort_id='role_name' then b.role_name end as role_name,
      case when sort_id='url' then b.url end as url,b.bidder_id,
      case when sort_id='source' then b.source end as source,
      b.applied,case when sort_id='applied_at' then b.applied_at end as applied_at,
      case when sort_id='arrangement' then b.arrangement end as arrangement,
      case when sort_id='job_status' then b.job_status end as job_status,b.review_status,
      case when sort_id='interview_scheduled' then b.interview_scheduled end as interview_scheduled,
      b.evidence_file_id
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
  ), status_filtered as not materialized (
    select f.* from filtered f where coalesce(p_query->>'status','all')='all' or
      (p_query->>'status'='pending_review' and f.review_status='pending') or
      (p_query->>'status'='applied' and f.applied) or
      (p_query->>'status'='unapplied' and not f.applied)
  ), current_evidence_sizes as materialized (
    -- The same filtered, RLS-visible evidence snapshot feeds sorting and counts.
    select f.id,file.size_bytes,count(*) over(partition by file.size_bytes)::integer as match_count
    from status_filtered f
    join public.files file on file.id=f.evidence_file_id and file.bid_id=f.id
      and file.workspace_id=f.workspace_id and file.bidder_id=f.bidder_id
      and file.kind='screenshot' and file.finalized
    where can_view_sizes
  ),
  status_counts as (
    select count(*) filter(where coalesce(p_query->>'status','all')='all' or
      (p_query->>'status'='pending_review' and f.review_status='pending') or
      (p_query->>'status'='applied' and f.applied) or
      (p_query->>'status'='unapplied' and not f.applied))::integer total_count,
      count(*)::integer all_count,count(*) filter(where f.applied)::integer applied_count,
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
      case when sort_id='screenshot_size_bytes' and not sort_desc then evidence.size_bytes end asc nulls last,
      case when sort_id='screenshot_size_bytes' and sort_desc then evidence.size_bytes end desc nulls last,
      f.found_at desc,f.id asc) as row_number
    from status_filtered f
    left join current_evidence_sizes evidence on sort_id='screenshot_size_bytes' and evidence.id=f.id
  ), page as (
    select id,row_number from sorted
    where row_number>page_index*page_size and row_number<=page_index*page_size+page_size
  ), sources as (
    select coalesce(jsonb_agg(source order by source),'[]'::jsonb) as values
    from (select distinct b.source from public.bids b
      where b.source<>'' and (nullif(p_query->>'scopeBidderId','') is null or b.bidder_id=(p_query->>'scopeBidderId')::uuid)) q
  )
  select jsonb_build_object(
    'rows',coalesce((select jsonb_agg(to_jsonb(b) || case when can_view_sizes then jsonb_build_object('screenshot_size_bytes',evidence.size_bytes,'screenshot_size_match_count',coalesce(evidence.match_count,0)) else '{}'::jsonb end order by page.row_number) from page join (select b.id,b.workspace_id,b.bidder_id,b.resume_id,b.company,b.role_name,b.url,b.normalized_url,b.source,b.arrangement,b.job_status,b.applied,b.found_at,b.applied_at,b.first_applied_at,b.evidence_file_id,b.rejected_hashes,b.version,b.created_at,b.deleted_at,b.deleted_by,b.review_status,b.review_revision,b.reviewed_by,b.reviewed_at,b.review_reason,b.interview_scheduled,b.interview_at,b.interview_notes,b.interview_updated_by,b.interview_updated_at,b.interview_tracking,b.application_method from public.bids b) b on b.id=page.id left join current_evidence_sizes evidence on evidence.id=b.id), '[]'::jsonb),
    'total',(select total_count from status_counts),
    'sources',(select values from sources),
    'statusCounts',(select jsonb_build_object('all',all_count,'applied',applied_count,'unapplied',unapplied_count,'pending_review',pending_count) from status_counts)
  ) into result;
  return result;
end $$;

revoke all on function public.list_bids_v2(jsonb) from public, anon;
grant execute on function public.list_bids_v2(jsonb) to authenticated;
