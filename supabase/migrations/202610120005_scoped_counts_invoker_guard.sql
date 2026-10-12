-- The scoped count RPC runs as authenticated, while require_manager is an
-- internal helper without an authenticated EXECUTE grant. Use its equivalent
-- public.manages check, which authenticated callers can already execute.
-- Preserve SECURITY INVOKER, RLS, count semantics and the existing RPC grants.
create or replace function public.resume_bid_counts_for_bidder(p_bidder uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare workspace_id uuid;
begin
  select b.workspace_id into workspace_id
    from public.bidders b where b.user_id=p_bidder;
  if workspace_id is null then raise exception 'Bidder not found'; end if;
  if not public.manages(workspace_id) then raise exception 'Access denied'; end if;
  return (
    select coalesce(jsonb_object_agg(summary.resume_id::text,summary.bid_count),'{}'::jsonb)
      from (
        select r.id resume_id,count(b.id)::integer bid_count
          from public.resumes r left join public.bids b on b.resume_id=r.id
          where r.bidder_id=p_bidder group by r.id
      ) summary
  );
end $$;
