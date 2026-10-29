-- Read-only counts. Run only against the linked production project; never emits customer data or paths.
select jsonb_build_object(
 'bids',(select count(*) from public.bids),
 'trashedBids',(select count(*) from public.bids where deleted_at is not null),
 'archivedCandidateProfiles',(select count(*) from public.candidate_profiles where archived),
 'archivedAssignments',(select count(*) from public.resumes where archived),
 'files',(select count(*) from public.files),
 'screenshotFiles',(select count(*) from public.files where kind='screenshot'),
 'screenshotBytes',(select coalesce(sum(size_bytes),0) from public.files where kind='screenshot'),
 'pendingStorageTasks',(select count(*) from public.storage_cleanup_tasks where completed_at is null),
 'storageObjects',(select count(*) from storage.objects where bucket_id='private-files'),
 'orphanStorageObjects',(select count(*) from storage.objects o where o.bucket_id='private-files'
  and not exists(select 1 from public.files f where f.storage_path=o.name)
  and not exists(select 1 from public.storage_cleanup_tasks t where t.storage_path=o.name and t.completed_at is null)),
 'expiredScreenshots',(select count(*) from public.files f
  left join public.screenshot_upload_contexts c on c.original_file_id=f.id
  left join public.bids b on b.evidence_file_id=f.id
  where f.kind='screenshot' and f.finalized
  and coalesce(c.uploaded_at,b.applied_at,f.created_at)<=statement_timestamp()-interval '168 hours'),
 'supersededFiles',(select count(*) from public.files f where f.finalized
  and not exists(select 1 from public.bids b where b.evidence_file_id=f.id)
  and not exists(select 1 from public.resumes r where r.file_id=f.id)),
 'cleanupSchedule',(select jsonb_agg(jsonb_build_object('job',jobname,'schedule',schedule,'active',active)) from cron.job where jobname='storage-cleanup'),
 'workerFailuresLastHour',(select count(*) from net._http_response where created>statement_timestamp()-interval '1 hour' and status_code is distinct from 200)
) as counts;
