-- Generic parameter estimates select pathological joins for this filtered RPC.
-- Plan its statements with actual arguments, scoped to this invoker function.
alter function public.list_bids_v2(jsonb) set plan_cache_mode = force_custom_plan;
