-- Private review context follows the application, including when file metadata
-- is cleaned up. original_file_id is a snapshot: intentionally NO file FK.
create table public.screenshot_upload_contexts (
 id uuid primary key default gen_random_uuid(),
 bid_id uuid not null references public.bids(id) on delete cascade,
 workspace_id uuid not null,
 bidder_id uuid not null,
 original_file_id uuid not null unique,
 uploader_id uuid not null,
 uploader_role text not null check(uploader_role in ('admin','client','bidder')),
 uploaded_at timestamptz not null,
 ip inet,
 city text check(char_length(city)<=120 and city !~ '[[:cntrl:]]'),
 region text check(region ~ '^[A-Z0-9]{1,3}$'),
 country text check(country ~ '^[A-Z]{2}$'),
 source text not null check(source in ('vercel','unavailable')),
 status text not null check(status in ('available','unavailable')),
 check((source='vercel' and status='available' and ip is not null)
  or (source='unavailable' and status='unavailable' and ip is null and city is null and region is null and country is null))
);
create index screenshot_upload_context_history on public.screenshot_upload_contexts(bid_id,uploaded_at desc,id desc);
alter table public.screenshot_upload_contexts enable row level security;
revoke all on public.screenshot_upload_contexts from public,anon,authenticated,service_role;
grant select on public.screenshot_upload_contexts to service_role;
create function public.guard_screenshot_upload_context_immutable() returns trigger
 language plpgsql security definer set search_path='' as $$
begin raise exception 'Upload context is immutable'; end $$;
revoke all on function public.guard_screenshot_upload_context_immutable() from public,anon,authenticated;
create trigger screenshot_upload_context_immutable before update on public.screenshot_upload_contexts
 for each row execute function public.guard_screenshot_upload_context_immutable();
create trigger cutover_write_guard before insert or update or delete on public.screenshot_upload_contexts
 for each row execute function public.guard_application_library_cutover_write();

-- Keep the original version for rollout compatibility. This service-only
-- version calls the existing hash/approval/rate finalizer under the same locks;
-- attachment and the first successful context insert commit together.
create function public.finalize_verified_file_v2(p_id uuid,p_sha text,p_actor uuid,p_context jsonb)
 returns void language plpgsql security definer set search_path='' as $$
declare initial public.files; f public.files; b public.bids; actor public.profiles;
 verified_ip inet; city text; region text; country text; source text='unavailable'; status text='unavailable'; successful_at timestamptz;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if p_actor is null or p_sha is null or p_sha !~ '^[a-f0-9]{64}$' then raise exception 'Invalid verified upload'; end if;
 perform set_config('request.jwt.claim.sub',p_actor::text,true);
 select * into initial from public.files where id=p_id;
 if initial.id is null or initial.created_by<>p_actor or not public.can_read(initial.workspace_id,initial.bidder_id) then raise exception 'Access denied'; end if;
 if initial.kind<>'screenshot' then perform public.finalize_verified_file(p_id,p_sha,p_actor); return; end if;
 -- Match the existing bid-before-file lock order and re-read both identities.
 select * into b from public.bids where id=initial.bid_id for update;
 select * into f from public.files where id=p_id for update;
 select * into actor from public.profiles where id=p_actor and not archived for share;
 if b.id is null or f.id is null or actor.id is null or f.created_by<>actor.id
  or f.bid_id<>b.id or f.workspace_id<>b.workspace_id or f.bidder_id<>b.bidder_id
  or not public.can_read(b.workspace_id,b.bidder_id) then raise exception 'Access denied'; end if;
 if actor.role in ('admin','client') and actor.approval_status<>'approved' then raise exception 'Access denied'; end if;
 -- A lost-response retry never backfills an old finalized file or changes IP.
 if f.finalized then perform public.finalize_verified_file(p_id,p_sha,p_actor); return; end if;
 if jsonb_typeof(p_context)='object' and p_context->>'source'='vercel' and p_context->>'status'='available'
  and coalesce(p_context->>'ip','') ~ '^[0-9A-Fa-f:.]+$' and char_length(p_context->>'ip')<=45
  and ((p_context->>'ip') like '%:%' or (p_context->>'ip') ~ '^(0|[1-9][0-9]{0,2})([.](0|[1-9][0-9]{0,2})){3}$') then
  begin
   verified_ip=(p_context->>'ip')::inet;
   if masklen(verified_ip)<>(case family(verified_ip) when 4 then 32 else 128 end) then verified_ip=null; end if;
  exception when invalid_text_representation then verified_ip=null;
  end;
  if verified_ip is not null then
   source='vercel'; status='available';
   city=nullif(trim(p_context->>'city'),'');
   if char_length(city)>120 or city ~ '[[:cntrl:]]' then city=null; end if;
   region=case when p_context->>'region' ~ '^[A-Z0-9]{1,3}$' then p_context->>'region' end;
   country=case when p_context->>'country' ~ '^[A-Z]{2}$' then p_context->>'country' end;
  end if;
 end if;
 perform public.finalize_verified_file(p_id,p_sha,p_actor);
 -- b.applied_at is the successful timestamp written by the original finalizer.
 select applied_at into successful_at from public.bids where id=f.bid_id;
 insert into public.screenshot_upload_contexts(bid_id,workspace_id,bidder_id,original_file_id,uploader_id,uploader_role,uploaded_at,ip,city,region,country,source,status)
 values(b.id,b.workspace_id,b.bidder_id,f.id,actor.id,actor.role,successful_at,verified_ip,city,region,country,source,status);
end $$;

create function public.manager_screenshot_upload_context(p_file uuid) returns jsonb
 language plpgsql stable security definer set search_path='' as $$
declare w uuid; result jsonb;
begin
 if not exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('admin','client')
  and not p.archived and p.approval_status='approved') then raise exception 'Access denied'; end if;
 select b.workspace_id into w from public.bids b join public.files f on f.id=b.evidence_file_id
  where f.id=p_file and f.kind='screenshot' and f.finalized and f.bid_id=b.id and f.workspace_id=b.workspace_id and f.bidder_id=b.bidder_id;
 if w is null or not public.manages(w) then raise exception 'Access denied to current screenshot'; end if;
 select jsonb_build_object('id',c.id,'bidId',c.bid_id,'originalFileId',c.original_file_id,'bidderId',c.bidder_id,
  'uploaderId',c.uploader_id,'uploaderRole',c.uploader_role,'uploaderName',p.display_name,'uploadedAt',c.uploaded_at,
  'ip',host(c.ip),'city',c.city,'region',c.region,'country',c.country,'source',c.source,'status',c.status,
  'fileAvailable',f.id is not null,'filename',f.filename) into result
 from public.screenshot_upload_contexts c left join public.files f on f.id=c.original_file_id and f.bid_id=c.bid_id and f.finalized
 left join public.profiles p on p.id=c.uploader_id where c.original_file_id=p_file and c.workspace_id=w;
 return result;
end $$;

create function public.manager_screenshot_upload_history(p_bid uuid,p_before_at timestamptz default null,p_before_id uuid default null)
 returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w uuid; result jsonb;
begin
 if not exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('admin','client')
  and not p.archived and p.approval_status='approved') then raise exception 'Access denied'; end if;
 select workspace_id into w from public.bids where id=p_bid;
 if w is null or not public.manages(w) then raise exception 'Access denied'; end if;
 if (p_before_at is null)<>(p_before_id is null) then raise exception 'Invalid history cursor'; end if;
 with page as materialized (
  select c.* from public.screenshot_upload_contexts c where c.bid_id=p_bid and c.workspace_id=w
   and (p_before_at is null or (c.uploaded_at,c.id)<(p_before_at,p_before_id)) order by c.uploaded_at desc,c.id desc limit 51
 ), visible as materialized (select * from page order by uploaded_at desc,id desc limit 50), serialized as (
  select c.uploaded_at,c.id,jsonb_build_object('id',c.id,'bidId',c.bid_id,'originalFileId',c.original_file_id,'bidderId',c.bidder_id,
   'uploaderId',c.uploader_id,'uploaderRole',c.uploader_role,'uploaderName',p.display_name,'uploadedAt',c.uploaded_at,
   'ip',host(c.ip),'city',c.city,'region',c.region,'country',c.country,'source',c.source,'status',c.status,
   'fileAvailable',f.id is not null,'filename',f.filename) value
  from visible c left join public.files f on f.id=c.original_file_id and f.bid_id=c.bid_id and f.finalized
  left join public.profiles p on p.id=c.uploader_id
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(value order by uploaded_at desc,id desc) from serialized),'[]'),
  'nextCursor',case when (select count(*) from page)>50 then
   (select jsonb_build_object('uploadedAt',uploaded_at,'id',id) from visible order by uploaded_at,id limit 1) else null end) into result;
 return result;
end $$;
revoke all on function public.finalize_verified_file_v2(uuid,text,uuid,jsonb),public.manager_screenshot_upload_context(uuid),public.manager_screenshot_upload_history(uuid,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.finalize_verified_file_v2(uuid,text,uuid,jsonb) to service_role;
grant execute on function public.manager_screenshot_upload_context(uuid),public.manager_screenshot_upload_history(uuid,timestamptz,uuid) to authenticated;
