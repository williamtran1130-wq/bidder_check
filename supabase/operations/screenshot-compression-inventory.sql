-- Read-only, counts/bytes only. Requires migration 202610290003.
-- Run as project owner after deployment; the older retention preflight remains
-- compatible with schemas before this migration. No image bodies are downloaded.
begin read only;
set local statement_timeout = '12s';
select jsonb_build_object(
 'checkedAt',statement_timestamp(),
 'finalizedScreenshotFiles',(select count(*) from public.files where kind='screenshot' and finalized),
 'originalScreenshotBytes',(select coalesce(sum(size_bytes),0) from public.files where kind='screenshot' and finalized),
 'retainedScreenshotBytes',(select coalesce(sum(coalesce(stored_size_bytes,size_bytes)),0) from public.files where kind='screenshot' and finalized),
 'compressedScreenshotFiles',(select count(*) from public.files where stored_size_bytes is not null),
 'storageObjects',(select count(*) from storage.objects where bucket_id='private-files'),
 'storageObjectBytes',(select coalesce(sum((metadata->>'size')::bigint),0) from storage.objects where bucket_id='private-files'),
 'finalizedObjectSizeMismatches',(select count(*) from public.files f join storage.objects o
  on o.bucket_id='private-files' and o.name=f.storage_path
  where f.finalized and (o.metadata->>'size')::bigint is distinct from coalesce(f.stored_size_bytes,f.size_bytes)::bigint),
 'missingFinalizedObjects',(select count(*) from public.files f where f.finalized
  and not exists(select 1 from storage.objects o where o.bucket_id='private-files' and o.name=f.storage_path)),
 'orphanStorageObjects',(select count(*) from storage.objects o where o.bucket_id='private-files'
  and not exists(select 1 from public.files f where f.storage_path=o.name)
  and not exists(select 1 from public.storage_cleanup_tasks t where t.storage_path=o.name and t.completed_at is null)),
 'candidateReservations',(select count(*) from private.screenshot_optimization_attempts),
 'pendingStorageTasks',(select count(*) from public.storage_cleanup_tasks where completed_at is null),
 'failedStorageTasks',(select count(*) from public.storage_cleanup_tasks where completed_at is null and last_error is not null)
) as inventory;
commit;
