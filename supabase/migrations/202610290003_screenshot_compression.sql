-- Original upload identity remains the proof identity. These columns describe only
-- the smaller retained artifact; legacy files continue to use the original fields.
alter table public.files
 add column stored_size_bytes integer,
 add column stored_mime text,
 add column stored_sha256 text,
 add constraint files_stored_representation_check check (
  (stored_size_bytes is null and stored_mime is null and stored_sha256 is null) or
  (stored_size_bytes is not null and stored_mime is not null and stored_sha256 is not null
   and kind='screenshot' and finalized and stored_size_bytes>0 and stored_size_bytes<size_bytes
   and stored_mime='image/webp' and stored_sha256 ~ '^[a-f0-9]{64}$')
 );

-- A candidate is private and is never a files.storage_path until activation. Its
-- cleanup task exists BEFORE the service uploads bytes. A missing task is unsafe,
-- including when normal queue pruning already erased a completed removal.
create table private.screenshot_optimization_attempts (
 id uuid primary key,
 file_id uuid not null references public.files(id) on delete cascade,
 storage_path text not null unique,
 cleanup_task_id uuid not null unique,
 expires_at timestamptz not null,
 activating boolean not null default false,
 stored_size_bytes integer,
 stored_sha256 text
);
create index screenshot_optimization_file on private.screenshot_optimization_attempts(file_id);
create unique index screenshot_optimization_activating on private.screenshot_optimization_attempts(file_id) where activating;
alter table private.screenshot_optimization_attempts enable row level security;
revoke all on private.screenshot_optimization_attempts from public,anon,authenticated,service_role;

-- Shared authorization and profile -> bid -> file lock protocol, also used at
-- activation after the potentially slow image conversion and Storage upload.
create function private.lock_screenshot_optimization(p_id uuid,p_actor uuid) returns public.files
language plpgsql security definer set search_path='' as $$
declare initial public.files; f public.files; b public.bids; pid uuid; begin
 if p_actor is null then raise exception 'Access denied'; end if;
 perform set_config('request.jwt.claim.sub',p_actor::text,true);
 select * into initial from public.files where id=p_id;
 select r.profile_id into pid from public.bids x join public.resumes r on r.id=x.resume_id where x.id=initial.bid_id;
 if initial.id is null or initial.kind<>'screenshot' or pid is null then raise exception 'Access denied'; end if;
 perform pg_advisory_xact_lock(hashtextextended(pid::text,0));
 select * into b from public.bids where id=initial.bid_id for update;
 select * into f from public.files where id=p_id for update;
 perform 1 from public.profiles where id=p_actor and not archived and approval_status='approved' for share;
 if not found or f.id is null or b.id is null or f.created_by<>p_actor
  or f.kind<>'screenshot' or f.bid_id<>b.id or f.workspace_id<>b.workspace_id or f.bidder_id<>b.bidder_id
  or not public.can_read(b.workspace_id,b.bidder_id) then raise exception 'Access denied'; end if;
 if b.deleted_at is not null or exists(select 1 from public.resumes r join public.candidate_profiles p on p.id=r.profile_id
  where r.id=b.resume_id and (r.archived or p.archived)) then raise exception 'Upload is unavailable'; end if;
 if (not f.finalized and f.created_at<=clock_timestamp()-interval '24 hours')
  or (f.finalized and f.finalized_at<=clock_timestamp()-interval '168 hours') then raise exception 'Upload expired'; end if;
 if not f.finalized and (b.review_status<>'approved' or f.review_revision is distinct from b.review_revision) then
  raise exception 'Client approval changed. Request approval before uploading new proof'; end if;
 return f;
end $$;

create function public.reserve_screenshot_optimization(p_id uuid,p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f public.files; attempt uuid=gen_random_uuid(); task uuid; path text; deadline timestamptz=clock_timestamp()+interval '10 minutes'; begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 f=private.lock_screenshot_optimization(p_id,p_actor);
 -- A concurrent request may finish while another caller is encoding. Return a
 -- server-only receipt so that caller can verify the original hash and succeed.
 if f.finalized then return jsonb_build_object('finalized',true,'sha256',f.sha256,
  'stored_size_bytes',coalesce(f.stored_size_bytes,f.size_bytes)); end if;
 path=f.workspace_id::text||'/'||f.bidder_id::text||'/'||f.id::text||'/optimized/'||attempt::text||'.webp';
 insert into public.storage_cleanup_tasks(storage_path,next_attempt_at) values(path,deadline) returning id into task;
 insert into private.screenshot_optimization_attempts(id,file_id,storage_path,cleanup_task_id,expires_at)
 values(attempt,f.id,path,task,deadline);
 return jsonb_build_object('attempt_id',attempt,'storage_path',path);
end $$;

-- The trigger injects representation data into the existing finalizer's ONE
-- unfinalized -> finalized write. No session setting can bypass immutability.
-- Only the service-only RPC can mark a private reservation as activating.
create function private.guard_file_representation() returns trigger
language plpgsql security definer set search_path='' as $$
declare candidate private.screenshot_optimization_attempts; begin
 if tg_op='UPDATE' and old.finalized and
  (new.storage_path is distinct from old.storage_path or new.stored_size_bytes is distinct from old.stored_size_bytes
   or new.stored_mime is distinct from old.stored_mime or new.stored_sha256 is distinct from old.stored_sha256
   or new.sha256 is distinct from old.sha256 or new.size_bytes is distinct from old.size_bytes
   or new.mime is distinct from old.mime or new.filename is distinct from old.filename) then
  raise exception 'Verified file representation is immutable';
 end if;
 if tg_op='UPDATE' and not old.finalized and new.finalized then
  select * into candidate from private.screenshot_optimization_attempts where file_id=new.id and activating;
  if found then
   new.storage_path=candidate.storage_path; new.stored_size_bytes=candidate.stored_size_bytes;
   new.stored_mime='image/webp'; new.stored_sha256=candidate.stored_sha256;
  end if;
 end if;
 return new;
end $$;
create trigger guard_file_representation before insert or update on public.files
 for each row execute function private.guard_file_representation();

create function public.finalize_optimized_screenshot(
 p_id uuid,p_actor uuid,p_sha text,p_context jsonb,p_attempt uuid,p_stored_size integer,p_stored_sha text
) returns void language plpgsql security definer set search_path='' as $$
declare f public.files; candidate private.screenshot_optimization_attempts; task public.storage_cleanup_tasks; begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if p_sha is null or p_sha !~ '^[a-f0-9]{64}$' then raise exception 'Invalid verified upload'; end if;
 f=private.lock_screenshot_optimization(p_id,p_actor);
 -- Retries keep the winner, including a concurrent loser with the same original
 -- proof. They do not cancel that loser's still-needed candidate cleanup.
 if f.finalized then
  if f.sha256 is distinct from p_sha then raise exception 'Immutable file'; end if;
  return;
 end if;
 if p_stored_size is null or p_stored_size<=0 or p_stored_size>=f.size_bytes
  or p_stored_sha is null or p_stored_sha !~ '^[a-f0-9]{64}$' then raise exception 'Invalid smaller stored representation'; end if;
 select * into candidate from private.screenshot_optimization_attempts where id=p_attempt and file_id=f.id for update;
 if candidate.id is null or candidate.expires_at<=clock_timestamp() then raise exception 'Optimization candidate expired or unavailable'; end if;
 -- Serialize cancellation against worker claiming. ANY claim permanently makes
 -- activation unsafe, even after the lease elapsed or cleanup returned an error.
 select * into task from public.storage_cleanup_tasks where id=candidate.cleanup_task_id for update;
 if task.id is null or task.storage_path is distinct from candidate.storage_path or task.attempts>0
  or task.lease_id is not null or task.lease_until is not null or task.first_removed_at is not null
  or task.completed_at is not null or task.next_attempt_at<=clock_timestamp() then
  raise exception 'Candidate cleanup has started or expired';
 end if;
 update private.screenshot_optimization_attempts set activating=true,stored_size_bytes=p_stored_size,stored_sha256=p_stored_sha where id=candidate.id;
 perform public.finalize_verified_file_v2(p_id,p_sha,p_actor,p_context);
 delete from public.storage_cleanup_tasks where id=task.id;
 insert into public.storage_cleanup_tasks(storage_path) values(f.storage_path);
 -- The winning path is now protected by the file row and its deletion hook.
 delete from private.screenshot_optimization_attempts where id=candidate.id;
end $$;

-- Covers replacement, parent deletion, expiry, abandoned uploads, and older
-- maintenance functions which directly delete files instead of detach_files.
create function private.queue_deleted_file_representations() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.storage_cleanup_tasks(operation_id,storage_path)
 select nullif(current_setting('app.cleanup_operation',true),'')::uuid,old.storage_path
 where not exists(select 1 from public.storage_cleanup_tasks where storage_path=old.storage_path and completed_at is null);
 update public.storage_cleanup_tasks t set next_attempt_at=least(t.next_attempt_at,clock_timestamp())
 from private.screenshot_optimization_attempts a where a.file_id=old.id and t.id=a.cleanup_task_id
 and t.completed_at is null and t.first_removed_at is null;
 return old;
end $$;
create trigger queue_deleted_file_representations before delete on public.files
 for each row execute function private.queue_deleted_file_representations();

-- Optimized artifacts always require the service's authorized, bounded signing
-- route, including before retention cutover activation. Unfinished original
-- uploads retain their existing verification access.
alter policy private_file_read on storage.objects using(bucket_id='private-files' and exists(
 select 1 from public.files f where f.storage_path=name and public.can_read(f.workspace_id,f.bidder_id)
 and (f.kind<>'screenshot' or (f.stored_size_bytes is null and
  (not public.screenshot_retention_enabled() or (not f.finalized and f.created_by=auth.uid()))))
));

revoke all on function private.lock_screenshot_optimization(uuid,uuid),private.guard_file_representation(),private.queue_deleted_file_representations() from public,anon,authenticated,service_role;
revoke all on function public.reserve_screenshot_optimization(uuid,uuid),public.finalize_optimized_screenshot(uuid,uuid,text,jsonb,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.reserve_screenshot_optimization(uuid,uuid),public.finalize_optimized_screenshot(uuid,uuid,text,jsonb,uuid,integer,text) to service_role;
