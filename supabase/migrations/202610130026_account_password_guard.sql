-- A legacy or self-service password-only Auth write has no changed journal
-- marker. Fence that conflicting effect at commit, while retaining the provider's
-- password-before-metadata ordering within a valid managed transaction.
create function public.guard_account_auth_password_write() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Serialize with begin/dispatch/receipt/reconcile, including a concurrent begin
 -- that has not yet committed its target reservation. Do not precheck unlocked.
 perform pg_advisory_xact_lock(220022);
 if exists (
  select 1 from public.account_operations o
  where o.target_id=new.id and o.status in ('ready','pending')
   and (o.auth_step<>'accepted' or o.auth_transaction is distinct from txid_current()
    or o.kind not in ('reset_password','create_client','create_bidder'))
 ) then
  raise exception 'Resolve the pending account operation first' using errcode='PBA01';
 end if;
 return new;
end $$;

-- JSON field access also supports the intentionally minimal auth.users test
-- stubs: absent password fields cannot represent a credential delta.
create constraint trigger account_auth_password_guard
 after update on auth.users deferrable initially deferred
 for each row when ((to_jsonb(old)->'encrypted_password') is distinct from (to_jsonb(new)->'encrypted_password'))
 execute function public.guard_account_auth_password_write();
revoke all on function public.guard_account_auth_password_write() from public,anon,authenticated,service_role;
