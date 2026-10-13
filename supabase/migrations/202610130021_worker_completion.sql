-- Batch transport only: retain the existing per-task lease checks and two-pass lifecycle.
create function public.finish_storage_cleanup_batch(p_tasks uuid[],p_leases uuid[],p_success boolean)
returns void language plpgsql security definer set search_path='' as $$
declare position integer;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if p_tasks is null or p_leases is null or p_success is null
    or cardinality(p_tasks)<>cardinality(p_leases) or cardinality(p_tasks)>100
    or array_position(p_tasks,null) is not null or array_position(p_leases,null) is not null
    or (cardinality(p_tasks)>0 and (array_ndims(p_tasks)<>1 or array_ndims(p_leases)<>1
        or array_lower(p_tasks,1)<>1 or array_lower(p_leases,1)<>1))
 then raise exception 'Invalid cleanup completion batch'; end if;
 for position in 1..cardinality(p_tasks) loop
  perform public.finish_storage_cleanup(p_tasks[position],p_leases[position],p_success);
 end loop;
end $$;
revoke all on function public.finish_storage_cleanup_batch(uuid[],uuid[],boolean) from public,anon,authenticated;
grant execute on function public.finish_storage_cleanup_batch(uuid[],uuid[],boolean) to service_role;
