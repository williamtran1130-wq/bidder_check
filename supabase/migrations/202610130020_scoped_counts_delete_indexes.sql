-- Preserve INVOKER/RLS and the explicit readable scope, including trusted
-- service callers whose table access bypasses RLS. Evaluate it per membership.
create or replace function public.resume_bid_counts() returns jsonb
language sql stable security invoker set search_path='' as $$
 with readable as materialized (select * from private.readable_bid_scope()),
 counts as (
  select b.resume_id,count(*)::integer bid_count
  from public.bids b join readable s on s.workspace_id=b.workspace_id and s.bidder_id=b.bidder_id
  group by b.resume_id
 )
 select coalesce(jsonb_object_agg(resume_id::text,bid_count),'{}'::jsonb) from counts
$$;

-- Only the four measured delete paths. Accept existing leading B-tree indexes
-- which cover all non-null references, rather than adding equivalent indexes.
do $migration$
declare target record;
begin
 for target in select * from (values
  ('files','bid_id','files_bid_delete_lookup'),
  ('files','resume_id','files_resume_delete_lookup'),
  ('bids','evidence_file_id','bids_evidence_delete_lookup'),
  ('bid_events','file_id','bid_events_file_delete_lookup')
 ) as targets(table_name,column_name,index_name) loop
  if not exists(
   select 1 from pg_catalog.pg_index i
   join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0]
   join pg_catalog.pg_class idx on idx.oid=i.indexrelid
   join pg_catalog.pg_am am on am.oid=idx.relam
   where i.indrelid=format('public.%I',target.table_name)::regclass
    and a.attname=target.column_name and i.indisvalid and i.indisready and am.amname='btree'
    and (i.indpred is null or pg_get_expr(i.indpred,i.indrelid)=format('(%I IS NOT NULL)',target.column_name))
  ) then
   execute format('create index %I on public.%I(%I) where %I is not null',target.index_name,target.table_name,target.column_name,target.column_name);
  end if;
 end loop;
end
$migration$;
