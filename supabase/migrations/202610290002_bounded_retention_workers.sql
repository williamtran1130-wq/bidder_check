-- Forward fix: keep maintenance transactions short and never wait on interactive rows.
-- The application cutover is latched independently so pausing cleanup does not reopen old APIs.
alter table public.file_retention_settings add column cutover_completed boolean not null default false;
update public.file_retention_settings set cutover_completed=enabled;
create function private.latch_file_retention_cutover() returns trigger language plpgsql security definer set search_path='' as $$
begin new.cutover_completed=old.cutover_completed or old.enabled or new.enabled or new.cutover_completed; return new; end $$;
create trigger latch_file_retention_cutover before update on public.file_retention_settings for each row execute function private.latch_file_retention_cutover();
revoke all on function private.latch_file_retention_cutover() from public,anon,authenticated,service_role;
create or replace function public.screenshot_retention_enabled() returns boolean language sql stable security definer set search_path='' as $$
 select cutover_completed from public.file_retention_settings;
$$;

create function private.prune_file_cleanup_history(p_limit integer) returns void language plpgsql security definer set search_path='' as $$
begin
 delete from public.screenshot_upload_contexts where id in(select c.id from public.screenshot_upload_contexts c where not exists(select 1 from public.files f where f.id=c.original_file_id) limit p_limit);
 delete from public.storage_cleanup_tasks where id in(select id from public.storage_cleanup_tasks where completed_at is not null limit p_limit);
 delete from public.bid_purge_operations where id in(select o.id from public.bid_purge_operations o where
  (o.completed_at is not null or o.expires_at<statement_timestamp()) and not exists(select 1 from public.storage_cleanup_tasks t where t.operation_id=o.id) limit p_limit);
end $$;
revoke all on function private.prune_file_cleanup_history(integer) from public,anon,authenticated,service_role;

do $$ declare signature text; definition text; begin
 -- Pause only background deletion. Keep the already activated signing/deletion contract enforced.
 foreach signature in array array['public.trash_bid(uuid,boolean)','public.bulk_bid_state(jsonb,boolean)',
 'public.archive_resume(uuid,boolean)','public.archive_resume_assignment(uuid,boolean)','public.archive_candidate_profile(uuid,boolean)',
 'private.erase_finished_cleanup()'] loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  execute replace(definition,'select enabled from public.file_retention_settings','select cutover_completed from public.file_retention_settings');
 end loop;

 -- All three SQL maintenance phases share one nonblocking transaction lock. Other invocations
 -- may still drain independently leased Storage tasks without competing over profile/bid locks.
 select pg_get_functiondef('public.process_screenshot_retention(integer)'::regprocedure) into definition;
 definition=replace(definition,'coalesce(p_limit,500),1),2000)','coalesce(p_limit,500),1),100)');
 definition=replace(definition,'clock_timestamp()','statement_timestamp()');
 definition=replace(definition,'-- Lock profile',
  'if not pg_try_advisory_xact_lock(hashtextextended(''file-retention-maintenance'',0)) then return jsonb_build_object(''deletedFiles'',0,''enabled'',true,''busy'',true); end if; -- Lock profile');
 definition=replace(definition,'where id=f.bid_id for update;','where id=f.bid_id for update skip locked;');
 definition=replace(definition,'where id=f.resume_id for update;','where id=f.resume_id for update skip locked;');
 definition=replace(definition,'select array_agg(x.id) into ids', 'if not found then continue; end if; select array_agg(x.id) into ids');
 definition=replace(definition,'perform private.detach_files(ids);','if exists(select 1 from public.files where id=f.id) then perform private.detach_files(ids); end if;');
 execute definition;

 select pg_get_functiondef('public.process_legacy_file_cleanup(integer)'::regprocedure) into definition;
 definition=replace(definition,'coalesce(p_limit,200),1),500)','coalesce(p_limit,200),1),100)');
 definition=replace(definition,'if not (select enabled from public.file_retention_settings)',
  'if not pg_try_advisory_xact_lock(hashtextextended(''file-retention-maintenance'',0)) then return jsonb_build_object(''processed'',0,''busy'',true); end if; perform private.prune_file_cleanup_history(lim); if not (select enabled from public.file_retention_settings)');
 definition=replace(definition,'where id=x.bid_id for update;','where id=x.bid_id for update skip locked;');
 definition=replace(definition,'where id=x.resume_id for update;','where id=x.resume_id for update skip locked;');
 definition=replace(definition,'where id=x.id for update;','where id=x.id for update skip locked;');
 definition=replace(definition,'-- Recheck archive/deletion','if not found then continue; end if; -- Recheck archive/deletion');
 definition=replace(definition,'if exists(select 1 from public.bids b join public.resumes r on r.id=b.resume_id','if not found then continue; end if; if exists(select 1 from public.bids b join public.resumes r on r.id=b.resume_id');
 definition=replace(definition,'if exists(select 1 from public.resumes r join public.candidate_profiles p on p.id=r.profile_id','if not found then continue; end if; if exists(select 1 from public.resumes r join public.candidate_profiles p on p.id=r.profile_id');
 definition=replace(definition,'if exists(select 1 from public.candidate_profiles p where p.id=x.id','if not found then continue; end if; if exists(select 1 from public.candidate_profiles p where p.id=x.id');
 execute definition;

 select pg_get_functiondef('public.process_candidate_retention(integer)'::regprocedure) into definition;
 definition=replace(definition,'coalesce(p_limit,500),1),2000)','coalesce(p_limit,500),1),100)');
 definition=replace(definition,'for profile in select id',
  'if not pg_try_advisory_xact_lock(hashtextextended(''file-retention-maintenance'',0)) then return jsonb_build_object(''deletedApplications'',0,''storageTasksQueued'',0,''limit'',batch_limit,''busy'',true); end if; for profile in select id');
 definition=replace(definition,'perform pg_advisory_xact_lock(hashtextextended(profile.id::text,0));',
  'if not pg_try_advisory_xact_lock(hashtextextended(profile.id::text,0)) then continue; end if;');
 definition=replace(definition,'where cp.id=profile.id for update;','where cp.id=profile.id for update skip locked;');
 execute definition;

 select pg_get_functiondef('public.has_due_storage_cleanup()'::regprocedure) into definition;
 definition=replace(definition,'or ((select enabled from public.file_retention_settings)',
  'or ((select cutover_completed from public.file_retention_settings) and (exists(select 1 from public.storage_cleanup_tasks where completed_at is not null) or exists(select 1 from public.bid_purge_operations o where (o.completed_at is not null or o.expires_at<statement_timestamp()) and not exists(select 1 from public.storage_cleanup_tasks t where t.operation_id=o.id)))) or ((select enabled from public.file_retention_settings)');
 execute definition;
end $$;
