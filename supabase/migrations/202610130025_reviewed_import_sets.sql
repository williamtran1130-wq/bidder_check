-- Set-based error mapping and one accepted-URL projection. Leave the ordered,
-- post-lock validator, fingerprints, zero receipts and atomic event writes intact.
create or replace function public.import_bids_reviewed(
 p_resume uuid,p_date date,p_rows jsonb,p_source_rows integer[],p_request uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 r public.resumes; receipt public.bid_import_receipts; fingerprint text; payload jsonb;
 errors jsonb; item_errors jsonb; item jsonb; skipped jsonb='[]'; valid_rows jsonb='[]';
 valid_sources integer[]='{}'; source_row integer; n integer=0; ids uuid[]='{}'; result jsonb;
 stamp timestamptz; request_lock bigint;
begin
 if auth.uid() is null or p_request is null then raise exception 'Import request ID required'; end if;
 if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 500 or coalesce(array_length(p_source_rows,1),0)<>jsonb_array_length(p_rows) then raise exception 'Import 1 to 500 mapped rows'; end if;
 if exists(select 1 from unnest(p_source_rows) x where x is null or x<1) or cardinality(p_source_rows)<>cardinality(array(select distinct x from unnest(p_source_rows) x)) then raise exception 'Import source row numbers are invalid'; end if;
 select * into r from public.resumes where id=p_resume;
 if r.id is null or not public.can_read(r.workspace_id,r.bidder_id) then raise exception 'Access denied'; end if;
 payload=jsonb_build_object('resume',p_resume,'date',p_date,'rows',p_rows,'source_rows',p_source_rows);
 fingerprint=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 request_lock=hashtextextended(auth.uid()::text||p_request::text,0);
 perform pg_advisory_xact_lock(request_lock);
 select * into receipt from public.bid_import_receipts where actor_id=auth.uid() and request_id=p_request;
 if receipt.request_id is not null then
  if receipt.payload_hash<>fingerprint then raise exception 'This request ID was already used with different content'; end if;
  select count(*)::integer into n from jsonb_array_elements_text(receipt.result->'ids') x where not exists(select 1 from public.bids where id=x.value::uuid);
  return case when n=0 then receipt.result else receipt.result||jsonb_build_object('purgedCount',n) end;
 end if;

 perform pg_advisory_xact_lock(hashtextextended(r.profile_id::text,0));
 errors=public.validate_bid_import(p_resume,p_date,p_rows);
 -- Preserve validator input-order quota/duplicate decisions. Group its errors
 -- once, retain their original order, and map each source row without rescans.
 with input as materialized (
  select value item,ordinality::integer n,p_source_rows[ordinality::integer] source_row
  from jsonb_array_elements(p_rows) with ordinality
 ), mapped_errors as materialized (
  select input.n,jsonb_agg(issue.value-'row'||jsonb_build_object('row',input.source_row) order by issue.ordinality) reasons
  from jsonb_array_elements(errors) with ordinality issue
  join input on input.n=(issue.value->>'row')::integer group by input.n
 ), reviewed as (
  select input.*,coalesce(mapped_errors.reasons,'[]'::jsonb) reasons
  from input left join mapped_errors on mapped_errors.n=input.n
 )
 select coalesce(jsonb_agg(v.item order by v.n) filter(where jsonb_array_length(v.reasons)=0),'[]'::jsonb),
  coalesce(array_agg(v.source_row order by v.n) filter(where jsonb_array_length(v.reasons)=0),'{}'::integer[]),
  coalesce(jsonb_agg(jsonb_build_object('sourceRow',v.source_row,'reasons',v.reasons) order by v.n) filter(where jsonb_array_length(v.reasons)>0),'[]'::jsonb)
 into valid_rows,valid_sources,skipped from reviewed v;
 if jsonb_array_length(valid_rows)=0 then
  result=jsonb_build_object('ids','[]'::jsonb,'sourceRows','[]'::jsonb,'skipped',skipped,'date',p_date,'bidder',r.bidder_id,'resume',r.id);
  insert into public.bid_import_receipts(actor_id,request_id,payload_hash,result) values(auth.uid(),p_request,fingerprint,result);
  return result;
 end if;

 stamp=case when p_date=(clock_timestamp() at time zone 'America/Chicago')::date then clock_timestamp() else p_date::timestamp at time zone 'America/Chicago' end;
 with input as materialized (
  select value item,ordinality::integer ordinal,public.normalize_job_url(value->>'url') normalized_url from jsonb_array_elements(valid_rows) with ordinality
 ), inserted as (
  insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,source,arrangement,job_status,found_at)
  select r.workspace_id,r.bidder_id,r.id,trim(n.item->>'company'),trim(n.item->>'role_name'),trim(n.item->>'url'),n.normalized_url,coalesce(n.item->>'source',''),n.item->>'arrangement',n.item->>'job_status',stamp
  from input n order by n.ordinal
  returning id,normalized_url
 ), events as (
  insert into public.bid_events(bid_id,actor_id,event,details)
  select i.id,auth.uid(),'imported',jsonb_build_object('request_id',p_request,'added_date',p_date)
  from inserted i
  returning bid_id
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'sourceRow',valid_sources[n.ordinal]) order by n.ordinal),'[]') into result
 from input n join inserted i on i.normalized_url=n.normalized_url
 where (select count(*) from events)>=0;
 select coalesce(array_agg((elements.value->>'id')::uuid order by (elements.value->>'sourceRow')::integer),'{}') into ids from jsonb_array_elements(result) as elements(value);
 result=jsonb_build_object('ids',to_jsonb(ids),'sourceRows',to_jsonb(valid_sources),'skipped',skipped,'date',p_date,'bidder',r.bidder_id,'resume',r.id);
 insert into public.bid_import_receipts(actor_id,request_id,payload_hash,result) values(auth.uid(),p_request,fingerprint,result);
 return result;
end $$;

revoke all on function public.import_bids_reviewed(uuid,date,jsonb,integer[],uuid) from public,anon;
grant execute on function public.import_bids_reviewed(uuid,date,jsonb,integer[],uuid) to authenticated;
