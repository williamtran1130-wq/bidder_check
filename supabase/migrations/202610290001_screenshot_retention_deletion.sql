-- Compatibility expansion. Automatic/legacy cleanup stays OFF until the new app is live.
create table public.file_retention_settings (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false
);
insert into public.file_retention_settings default values;
alter table public.file_retention_settings enable row level security;
revoke all on public.file_retention_settings from public,anon,authenticated;
grant all on public.file_retention_settings to service_role;

alter table public.files add column finalized_at timestamptz;
alter table public.bids add column screenshot_uploaded_at timestamptz;
alter table public.bids add column screenshot_sha256 text;
update public.files f set finalized_at=coalesce(
 (select c.uploaded_at from public.screenshot_upload_contexts c where c.original_file_id=f.id),
 (select b.applied_at from public.bids b where b.evidence_file_id=f.id),f.created_at)
where f.finalized;
update public.bids b set screenshot_uploaded_at=f.finalized_at,screenshot_sha256=f.sha256
from public.files f where f.id=b.evidence_file_id and f.kind='screenshot' and f.finalized;
create index files_screenshot_expiry on public.files(finalized_at,id) where finalized and kind='screenshot';
create index files_abandoned_uploads on public.files(created_at,id) where not finalized;
-- Each bounded expiry pass detaches files individually; avoid scanning event/bid history per image.
create index bids_current_evidence_cleanup on public.bids(evidence_file_id) where evidence_file_id is not null;
create index resumes_current_file_cleanup on public.resumes(file_id) where file_id is not null;
create index bid_events_file_cleanup on public.bid_events(file_id) where file_id is not null;
create index storage_cleanup_path_pending on public.storage_cleanup_tasks(storage_path) where completed_at is null;

alter table public.bids drop constraint bids_application_state_check;
alter table public.bids add constraint bids_application_state_check check (
 not applied or (rate_cents is not null and applied_at is not null and
 (application_method='manual' or (application_method='screenshot' and
 (evidence_file_id is not null or (screenshot_uploaded_at is not null and screenshot_sha256 is not null)))))
);

create function private.stamp_verified_file() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then
  if new.finalized then new.finalized_at=coalesce(new.finalized_at,clock_timestamp()); else new.finalized_at=null; end if;
  return new;
 end if;
 if old.finalized and (new.finalized_at is distinct from old.finalized_at or not new.finalized) then
  raise exception 'Verified upload timestamp is immutable';
 end if;
 if new.finalized and not old.finalized then new.finalized_at=clock_timestamp(); end if;
 return new;
end $$;
create trigger stamp_verified_file before insert or update on public.files for each row execute function private.stamp_verified_file();

-- A file deletion always leaves a durable path, and active activity events keep no dangling FK.
create function private.detach_files(p_ids uuid[],p_operation uuid default null) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer; begin
 perform 1 from public.files where id=any(p_ids) order by id for update;
 insert into public.storage_cleanup_tasks(operation_id,storage_path)
 select coalesce(p_operation,nullif(current_setting('app.cleanup_operation',true),'')::uuid),f.storage_path from public.files f where f.id=any(p_ids)
 and not exists(select 1 from public.storage_cleanup_tasks t where t.storage_path=f.storage_path and t.completed_at is null);
 update public.bid_events set file_id=null where file_id=any(p_ids);
 delete from public.screenshot_upload_contexts where original_file_id=any(p_ids);
 delete from public.files where id=any(p_ids);
 get diagnostics n=row_count;
 return n;
end $$;

grant select(screenshot_uploaded_at) on public.bids to authenticated;

create function private.snapshot_screenshot() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.evidence_file_id is not null then
  select f.finalized_at,f.sha256 into new.screenshot_uploaded_at,new.screenshot_sha256
  from public.files f where f.id=new.evidence_file_id and f.kind='screenshot' and f.finalized
   and f.bid_id=new.id and f.workspace_id=new.workspace_id and f.bidder_id=new.bidder_id;
  if new.screenshot_uploaded_at is null then raise exception 'Screenshot must be verified'; end if;
 elsif not new.applied or new.application_method='manual' then
  new.screenshot_uploaded_at=null; new.screenshot_sha256=null;
 end if;
 return new;
end $$;
create trigger snapshot_screenshot before insert or update of evidence_file_id,applied,application_method on public.bids
 for each row execute function private.snapshot_screenshot();

create function private.cleanup_replaced_file() returns trigger language plpgsql security definer set search_path='' as $$
declare old_id uuid; new_id uuid; begin
 if tg_table_name='bids' then old_id=old.evidence_file_id; new_id=new.evidence_file_id;
 else old_id=old.file_id; new_id=new.file_id; end if;
 if old_id is not null and old_id is distinct from new_id then perform private.detach_files(array[old_id]); end if;
 return new;
end $$;
create trigger cleanup_replaced_screenshot after update of evidence_file_id on public.bids for each row execute function private.cleanup_replaced_file();
create trigger cleanup_replaced_resume after update of file_id on public.resumes for each row execute function private.cleanup_replaced_file();

create or replace function public.set_applied(p_bid uuid,p_applied boolean,p_file uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare b public.bids; pid uuid; begin
 select r.profile_id into pid from public.bids x join public.resumes r on r.id=x.resume_id where x.id=p_bid;
 if pid is null then raise exception 'Access denied'; end if;
 perform pg_advisory_xact_lock(hashtextextended(pid::text,0));
 select * into b from public.bids where id=p_bid for update;
 if b.id is null or not public.manages(b.workspace_id) then raise exception 'Access denied'; end if;
 if p_applied is distinct from false then raise exception 'Upload a screenshot to apply automatically'; end if;
 if length(trim(coalesce(p_reason,'')))=0 then raise exception 'A correction reason is required'; end if;
 if not b.applied then return; end if;
 update public.bids set applied=false,evidence_file_id=null,version=version+1,
 rejected_hashes=case when b.screenshot_sha256 is not null and not b.screenshot_sha256=any(rejected_hashes)
  then array_append(rejected_hashes,b.screenshot_sha256) else rejected_hashes end where id=b.id;
 insert into public.bid_events(bid_id,actor_id,event,reason) values(b.id,auth.uid(),'unapplied',left(trim(p_reason),1000));
end $$;

-- Add only the safe timestamp to the existing explicit list projection; hashes remain private state.
do $$ declare definition text; begin
 select pg_get_functiondef('public.list_bids_v2(jsonb)'::regprocedure) into definition;
 definition=replace(definition,'b.application_method from public.bids b','b.application_method,b.screenshot_uploaded_at from public.bids b');
 execute definition;
end $$;

-- Finalized screenshots are signed only by the application after caller-scoped authorization
-- and TTL capping. Deny direct signing/download so a client cannot request a year-long token.
-- Unfinalized owner uploads stay readable for verification; resume permissions are unchanged.
-- Preserve old-app signing until the compatible application has been deployed and activated.
create function public.screenshot_retention_enabled() returns boolean language sql stable security definer set search_path='' as $$
 select enabled from public.file_retention_settings;
$$;
revoke all on function public.screenshot_retention_enabled() from public,anon;
grant execute on function public.screenshot_retention_enabled() to authenticated,service_role;
alter policy private_file_read on storage.objects using(bucket_id='private-files' and exists(
 select 1 from public.files f where f.storage_path=name and public.can_read(f.workspace_id,f.bidder_id)
 and (f.kind<>'screenshot' or not public.screenshot_retention_enabled() or (not f.finalized and f.created_by=auth.uid()))
));

create function public.process_screenshot_retention(p_limit integer default 500) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f record; ids uuid[]; n integer=0; lim integer=least(greatest(coalesce(p_limit,500),1),2000); begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if not (select enabled from public.file_retention_settings) then return jsonb_build_object('deletedFiles',0,'enabled',false); end if;
 -- Lock profile -> bid/assignment -> file, matching interactive mutations.
 for f in select x.id,x.bid_id,x.resume_id,coalesce(r.profile_id,br.profile_id) pid
 from public.files x left join public.resumes r on r.id=x.resume_id
 left join public.bids b on b.id=x.bid_id left join public.resumes br on br.id=b.resume_id
 where (x.kind='screenshot' and x.finalized and x.finalized_at<=clock_timestamp()-interval '168 hours')
 or (not x.finalized and x.created_at<=clock_timestamp()-interval '24 hours')
 order by x.created_at,x.id limit lim loop
  if f.pid is not null and not pg_try_advisory_xact_lock(hashtextextended(f.pid::text,0)) then continue; end if;
  if f.bid_id is not null then perform 1 from public.bids where id=f.bid_id for update;
  else perform 1 from public.resumes where id=f.resume_id for update; end if;
  select array_agg(x.id) into ids from public.files x where x.id=f.id and
   ((x.kind='screenshot' and x.finalized and x.finalized_at<=clock_timestamp()-interval '168 hours')
    or (not x.finalized and x.created_at<=clock_timestamp()-interval '24 hours'));
  if ids is null then continue; end if;
  update public.bids set evidence_file_id=null,version=version+1 where evidence_file_id=any(ids);
  perform private.detach_files(ids);
  -- Current screenshots were detached by the pointer trigger.
  if not exists(select 1 from public.files where id=f.id) then n=n+1; end if;
 end loop;
 return jsonb_build_object('deletedFiles',n,'enabled',true);
end $$;

-- Old tabs must refresh rather than silently interpreting archive/trash as permanent deletion.
do $$ declare signature text; definition text; begin
 foreach signature in array array['public.trash_bid(uuid,boolean)','public.bulk_bid_state(jsonb,boolean)',
 'public.archive_resume(uuid,boolean)','public.archive_resume_assignment(uuid,boolean)','public.archive_candidate_profile(uuid,boolean)'] loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  definition=regexp_replace(definition,'\m[Bb][Ee][Gg][Ii][Nn]\M',
   'begin if (select enabled from public.file_retention_settings) then raise exception ''This action changed. Refresh the page to use permanent deletion.''; end if;');
  execute definition;
 end loop;
end $$;

create function private.erase_finished_cleanup() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.completed_at is not null and (select enabled from public.file_retention_settings) then
  delete from public.storage_cleanup_tasks where id=new.id;
  delete from public.bid_purge_operations o where o.id=new.operation_id and o.completed_at is not null
   and not exists(select 1 from public.storage_cleanup_tasks t where t.operation_id=o.id);
 end if;
 return null;
end $$;
create trigger erase_finished_cleanup after update of completed_at on public.storage_cleanup_tasks
 for each row when(new.completed_at is not null) execute function private.erase_finished_cleanup();
revoke all on function private.erase_finished_cleanup() from public,anon,authenticated,service_role;

create function private.delete_bid_records(p_ids uuid[],p_operation uuid default null) returns integer
language plpgsql security definer set search_path='' as $$
declare files uuid[]; n integer; begin
 select array_agg(id) into files from public.files where bid_id=any(p_ids);
 -- Clear file event FKs before pointer-trigger cleanup.
 update public.bid_events set file_id=null where file_id=any(files);
 update public.bids set applied=false,evidence_file_id=null where id=any(p_ids);
 perform private.detach_files(files,p_operation);
 delete from public.bid_events where bid_id=any(p_ids);
 delete from public.bids where id=any(p_ids); get diagnostics n=row_count;
 return n;
end $$;

create function private.start_cleanup_operation() returns uuid language plpgsql security definer set search_path='' as $$
declare op uuid; begin
 if auth.role()='service_role' then return null; end if;
 op=nullif(current_setting('app.cleanup_operation',true),'')::uuid;
 if not exists(select 1 from public.bid_purge_operations where id=op and actor_id=auth.uid()) then op=null; end if;
 if op is null then
  insert into public.bid_purge_operations(actor_id,scope,targets,count,completed_at)
  values(auth.uid(),'Permanently deleted records','[]',0,clock_timestamp()) returning id into op;
  perform set_config('app.cleanup_operation',op::text,true);
 end if;
 return op;
end $$;

create function public.delete_bids(p_targets jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t jsonb; b public.bids; pid uuid; ids uuid[]; n integer; op uuid; begin
 if auth.uid() is null or jsonb_typeof(p_targets) is distinct from 'array' or jsonb_array_length(p_targets) not between 1 and 500 then raise exception 'Select 1 to 500 bids'; end if;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_targets))<>jsonb_array_length(p_targets) then raise exception 'Duplicate targets'; end if;
 for pid in select distinct r.profile_id from public.bids x join public.resumes r on r.id=x.resume_id
 where x.id in(select (value->>'id')::uuid from jsonb_array_elements(p_targets)) order by r.profile_id loop
  perform pg_advisory_xact_lock(hashtextextended(pid::text,0));
 end loop;
 for t in select value from jsonb_array_elements(p_targets) order by value->>'id' loop
  select * into b from public.bids where id=(t->>'id')::uuid for update;
  if b.id is null or not public.can_read(b.workspace_id,b.bidder_id) then raise exception 'Access denied'; end if;
  if b.version is distinct from (t->>'version')::integer then raise exception 'A selected bid changed. Refresh and select it again'; end if;
 end loop;
 select array_agg((value->>'id')::uuid) into ids from jsonb_array_elements(p_targets);
 op=private.start_cleanup_operation(); n=private.delete_bid_records(ids,op);
 update public.bid_purge_operations set count=n where id=op;
 return jsonb_build_object('deletedCount',n,'operationId',op);
end $$;

create function public.delete_resume_assignment(p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.resumes; ids uuid[]; files uuid[]; n integer; op uuid; original_profile uuid; begin
 select * into r from public.resumes where id=p_id;
 if r.id is null or (auth.role() is distinct from 'service_role' and not public.manages(r.workspace_id)) then raise exception 'Access denied'; end if;
 original_profile=r.profile_id;
 perform pg_advisory_xact_lock(hashtextextended(original_profile::text,0));
 select * into r from public.resumes where id=p_id for update;
 if r.id is null or r.profile_id is distinct from original_profile then raise exception 'Assignment changed. Refresh before deleting'; end if;
 perform 1 from public.bids where resume_id=p_id order by id for update;
 select array_agg(id) into ids from public.bids where resume_id=p_id;
 op=private.start_cleanup_operation(); n=private.delete_bid_records(ids,op);
 select array_agg(id) into files from public.files where resume_id=p_id;
 update public.resumes set file_id=null where id=p_id;
 perform private.detach_files(files);
 update public.bid_import_receipts set result=jsonb_build_object('ids','[]'::jsonb,'purged',true)
 where result->>'resume'=p_id::text;
 delete from public.resumes where id=p_id;
 update public.bid_purge_operations set count=n where id=op;
 return jsonb_build_object('deletedCount',n,'operationId',op);
end $$;

create function public.delete_candidate_profile(p_profile uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid; r record; n integer=0; result jsonb; op uuid; begin
 select workspace_id into w from public.candidate_profiles where id=p_profile;
 if w is null or (auth.role() is distinct from 'service_role' and not public.manages(w)) then raise exception 'Access denied'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_profile::text,0));
 perform 1 from public.candidate_profiles where id=p_profile for update;
 op=private.start_cleanup_operation();
 for r in select id from public.resumes where profile_id=p_profile order by id loop
  result=public.delete_resume_assignment(r.id); n=n+(result->>'deletedCount')::integer;
 end loop;
 delete from public.candidate_profiles where id=p_profile;
 update public.bid_purge_operations set count=n where id=op;
 return jsonb_build_object('deletedCount',n,'operationId',op);
end $$;

-- Service-only bounded legacy pass. Never touches archived account records.
create function public.process_legacy_file_cleanup(p_limit integer default 200) returns jsonb
language plpgsql security definer set search_path='' as $$
declare x record; lim integer=least(greatest(coalesce(p_limit,200),1),500); n integer=0; begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if not (select enabled from public.file_retention_settings) then return jsonb_build_object('processed',0); end if;
 -- Files first, then empty children/parents. Limit actual records, not whole profile trees.
 -- Try-lock avoids accumulating profile locks in an order conflicting with interactive bulk operations.
 for x in select f.id,f.bid_id,f.resume_id,coalesce(r.profile_id,br.profile_id) pid,
  coalesce(b.deleted_at is not null or br.archived or bp.archived,false) deleting_bid
 from public.files f left join public.resumes r on r.id=f.resume_id
 left join public.candidate_profiles rp on rp.id=r.profile_id
 left join public.bids b on b.id=f.bid_id left join public.resumes br on br.id=b.resume_id
 left join public.candidate_profiles bp on bp.id=br.profile_id
 where r.archived or rp.archived or b.deleted_at is not null or br.archived or bp.archived
 or (f.finalized and not exists(select 1 from public.bids v where v.evidence_file_id=f.id)
  and not exists(select 1 from public.resumes v where v.file_id=f.id))
 order by f.id limit lim loop
  if x.pid is not null and not pg_try_advisory_xact_lock(hashtextextended(x.pid::text,0)) then continue; end if;
  if x.bid_id is not null then perform 1 from public.bids where id=x.bid_id for update;
  else perform 1 from public.resumes where id=x.resume_id for update; end if;
  -- Recheck archive/deletion and pointer state under the same locks as writes.
  if exists(select 1 from public.files f left join public.resumes r on r.id=f.resume_id
   left join public.candidate_profiles rp on rp.id=r.profile_id
   left join public.bids b on b.id=f.bid_id left join public.resumes br on br.id=b.resume_id
   left join public.candidate_profiles bp on bp.id=br.profile_id where f.id=x.id and
   (r.archived or rp.archived or b.deleted_at is not null or br.archived or bp.archived or
    (f.finalized and not exists(select 1 from public.bids v where v.evidence_file_id=f.id)
     and not exists(select 1 from public.resumes v where v.file_id=f.id)))) then
   update public.bids set applied=false,evidence_file_id=null,version=version+1 where evidence_file_id=x.id;
   update public.resumes set file_id=null where file_id=x.id;
   perform private.detach_files(array[x.id]); n=n+1;
  end if;
 end loop;
 for x in select b.id,r.profile_id from public.bids b join public.resumes r on r.id=b.resume_id
 join public.candidate_profiles p on p.id=r.profile_id
 where (b.deleted_at is not null or r.archived or p.archived) and not exists(select 1 from public.files f where f.bid_id=b.id)
 order by b.id limit greatest(0,lim-n) loop
  if not pg_try_advisory_xact_lock(hashtextextended(x.profile_id::text,0)) then continue; end if;
  perform 1 from public.bids where id=x.id for update;
  if exists(select 1 from public.bids b join public.resumes r on r.id=b.resume_id join public.candidate_profiles p on p.id=r.profile_id
   where b.id=x.id and (b.deleted_at is not null or r.archived or p.archived) and not exists(select 1 from public.files f where f.bid_id=b.id)) then
   n=n+private.delete_bid_records(array[x.id]);
  end if;
 end loop;
 for x in select r.id,r.profile_id from public.resumes r join public.candidate_profiles p on p.id=r.profile_id
 where (r.archived or p.archived) and not exists(select 1 from public.bids b where b.resume_id=r.id)
 and not exists(select 1 from public.files f where f.resume_id=r.id) order by r.id limit greatest(0,lim-n) loop
  if not pg_try_advisory_xact_lock(hashtextextended(x.profile_id::text,0)) then continue; end if;
  perform 1 from public.resumes where id=x.id for update;
  if exists(select 1 from public.resumes r join public.candidate_profiles p on p.id=r.profile_id
   where r.id=x.id and (r.archived or p.archived)
   and not exists(select 1 from public.bids b where b.resume_id=r.id)
   and not exists(select 1 from public.files f where f.resume_id=r.id)) then
   perform public.delete_resume_assignment(x.id); n=n+1;
  end if;
 end loop;
 for x in select p.id from public.candidate_profiles p where p.archived
 and not exists(select 1 from public.resumes r where r.profile_id=p.id) order by p.id limit greatest(0,lim-n) loop
  if not pg_try_advisory_xact_lock(hashtextextended(x.id::text,0)) then continue; end if;
  perform 1 from public.candidate_profiles where id=x.id for update;
  if exists(select 1 from public.candidate_profiles p where p.id=x.id and p.archived
   and not exists(select 1 from public.resumes r where r.profile_id=p.id)) then
   perform public.delete_candidate_profile(x.id); n=n+1;
  end if;
 end loop;
 delete from public.screenshot_upload_contexts where id in(select c.id from public.screenshot_upload_contexts c where not exists(select 1 from public.files f where f.id=c.original_file_id) limit lim);
 delete from public.storage_cleanup_tasks where id in(select id from public.storage_cleanup_tasks where completed_at is not null limit lim);
 delete from public.bid_purge_operations where id in(select o.id from public.bid_purge_operations o where not exists(select 1 from public.storage_cleanup_tasks t where t.operation_id=o.id)
 and (o.completed_at is not null or o.expires_at<clock_timestamp()) limit lim);
 return jsonb_build_object('processed',n);
end $$;

create or replace function public.has_due_storage_cleanup() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.storage_cleanup_tasks where completed_at is null and next_attempt_at<=statement_timestamp() and (lease_until is null or lease_until<statement_timestamp()))
 or ((select enabled from public.file_retention_settings) and (
 exists(select 1 from public.files where (kind='screenshot' and finalized and finalized_at<=statement_timestamp()-interval '168 hours') or (not finalized and created_at<=statement_timestamp()-interval '24 hours'))
 or exists(select 1 from public.storage_cleanup_tasks where completed_at is not null)
 or exists(select 1 from public.bid_purge_operations o where (o.completed_at is not null or o.expires_at<statement_timestamp()) and not exists(select 1 from public.storage_cleanup_tasks t where t.operation_id=o.id))
 or exists(select 1 from public.screenshot_upload_contexts c where not exists(select 1 from public.files f where f.id=c.original_file_id))
 or exists(select 1 from public.candidate_profiles where archived)
 or exists(select 1 from public.resumes where archived)
 or exists(select 1 from public.bids b join public.resumes r on r.id=b.resume_id join public.candidate_profiles p on p.id=r.profile_id
  where b.deleted_at is not null or (b.applied and p.retention_months is not null and b.applied_at<public.candidate_retention_cutoff(statement_timestamp(),p.retention_months)))
 or exists(select 1 from public.files f where f.finalized and not exists(select 1 from public.bids b where b.evidence_file_id=f.id) and not exists(select 1 from public.resumes r where r.file_id=f.id))
 ));
$$;

-- SQL helpers are not remotely callable. Public RPC permissions are explicit.
revoke all on function private.stamp_verified_file(),private.snapshot_screenshot(),private.cleanup_replaced_file(),private.detach_files(uuid[],uuid),private.delete_bid_records(uuid[],uuid),private.start_cleanup_operation() from public,anon,authenticated,service_role;
revoke all on function public.process_screenshot_retention(integer),public.process_legacy_file_cleanup(integer) from public,anon,authenticated;
grant execute on function public.process_screenshot_retention(integer),public.process_legacy_file_cleanup(integer) to service_role;
revoke all on function public.delete_bids(jsonb),public.delete_resume_assignment(uuid),public.delete_candidate_profile(uuid) from public,anon;
grant execute on function public.delete_bids(jsonb),public.delete_resume_assignment(uuid),public.delete_candidate_profile(uuid) to authenticated;

create or replace function public.bid_purge_status(p_operation uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare op public.bid_purge_operations; stamp timestamptz=clock_timestamp(); pending integer; removing integer; verifying integer; processing integer; failed integer; next_at timestamptz; begin
 select * into op from public.bid_purge_operations where id=p_operation;
 if auth.uid() is null then raise exception 'Access denied'; end if;
 if op.id is null then return jsonb_build_object('id',p_operation,'scope','Cleanup finished or unavailable','deletedCount',0,'pendingFiles',0,'awaitingRemovalFiles',0,'verifyingFiles',0,'processingFiles',0,'failedFiles',0,'nextAttemptAt',null,'serverTime',stamp); end if;
 if op.actor_id<>auth.uid() or not exists(select 1 from public.profiles where id=auth.uid() and not archived and approval_status='approved') then raise exception 'Access denied'; end if;
 if op.bidder_id is not null and not exists(select 1 from public.bidders where user_id=op.bidder_id and public.manages(workspace_id)) then raise exception 'Access denied'; end if;
 select count(*) filter(where completed_at is null),
  count(*) filter(where completed_at is null and first_removed_at is null),
  count(*) filter(where completed_at is null and first_removed_at is not null),
  count(*) filter(where completed_at is null and lease_until>stamp),
  count(*) filter(where completed_at is null and (lease_until is null or lease_until<=stamp) and last_error is not null),
  min(next_attempt_at) filter(where completed_at is null and (lease_until is null or lease_until<=stamp))
 into pending,removing,verifying,processing,failed,next_at from public.storage_cleanup_tasks where operation_id=op.id;
 return jsonb_build_object('id',op.id,'scope',op.scope,'deletedCount',case when op.completed_at is not null then op.count else 0 end,'pendingFiles',pending,'awaitingRemovalFiles',removing,'verifyingFiles',verifying,'processingFiles',processing,'failedFiles',failed,'nextAttemptAt',next_at,'serverTime',stamp);
end $$;


-- One set-based deletion hook covers every path, including monthly retention and old purge workers.
create index bid_import_receipt_ids on public.bid_import_receipts using gin ((result->'ids'));
create function private.scrub_deleted_bid_receipts() returns trigger language plpgsql security definer set search_path='' as $$
declare p_ids uuid[]; begin
 select array_agg(id) into p_ids from removed_bids;
 if p_ids is null then return null; end if;
 update public.bid_import_receipts receipt set result=jsonb_set(jsonb_set(result,'{ids}',
  coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(receipt.result->'ids','[]')) v where not (v#>>'{}')=any(p_ids::text[])),'[]')),
  '{sourceRows}',coalesce((select jsonb_agg(receipt.result->'sourceRows'->(position-1)::integer order by position)
   from jsonb_array_elements_text(coalesce(receipt.result->'ids','[]')) with ordinality x(id,position)
   where not x.id=any(p_ids::text[])),'[]'))
  ||jsonb_build_object('purgedCount',coalesce((result->>'purgedCount')::integer,0)+
   (select count(*) from jsonb_array_elements_text(coalesce(receipt.result->'ids','[]')) v where v=any(p_ids::text[])))
 where result->'ids' ?| p_ids::text[];
 return null;
end $$;
create trigger scrub_deleted_bid_receipts after delete on public.bids referencing old table as removed_bids
 for each statement execute function private.scrub_deleted_bid_receipts();
revoke all on function private.scrub_deleted_bid_receipts() from public,anon,authenticated,service_role;

-- Assignment creation/reassignment participates in the same parent-before-child protocol.
do $$ declare definition text; begin
 select pg_get_functiondef('public.save_resume_assignment(uuid,uuid,uuid,text,text,uuid,integer)'::regprocedure) into definition;
 definition=replace(definition,'current_row public.resumes;','current_row public.resumes; lock_profile uuid;');
 definition=regexp_replace(definition,'\m[Bb][Ee][Gg][Ii][Nn]\M',
 'begin for lock_profile in select id from (select p_profile id union select profile_id from public.resumes where id=p_id) locks order by id loop perform pg_advisory_xact_lock(hashtextextended(lock_profile::text,0)); end loop;');
 execute definition;
end $$;
