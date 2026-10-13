-- Forward-only notification rollout. Apply before the application deployment.
alter table public.client_messages add column send_on_publish boolean not null default false;
create index client_messages_due on public.client_messages(next_at,id) where status in ('scheduled','active');
create index client_messages_cursor on public.client_messages(workspace_id,created_at desc,id desc);
create index inbox_notifications_cursor on public.inbox_notifications(user_id,created_at desc,id desc);
create index inbox_notifications_unread on public.inbox_notifications(user_id,kind) where read_at is null and resolved_at is null;
create index push_attempts_unfinished on public.push_attempts(next_attempt_at,id) where delivered_at is null;
create index message_occurrences_latest on public.message_occurrences(message_id,published_at desc,id desc);
create index push_subscriptions_user_created on public.push_subscriptions(user_id,created_at,id);

-- All wall-clock input passes through this resolver. PostgreSQL's spring gap
-- mapping shifts recurring times forward; once times must actually exist.
create function public.resolve_notification_schedule(p_schedule jsonb,p_after timestamptz default clock_timestamp(),p_require_future boolean default true)
returns timestamptz language plpgsql stable security definer set search_path='' as $$
declare kind text=p_schedule->>'kind'; local_stamp timestamp; stamp timestamptz; local_time time; days smallint[];
begin
 if kind='now' then return p_after; end if;
 if kind='once' then
  if coalesce(p_schedule->>'scheduled_local','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' then raise exception 'Choose a valid Central Time send date'; end if;
  local_stamp=(p_schedule->>'scheduled_local')::timestamp;
  stamp=public.message_occurrence_at(local_stamp::date,local_stamp::time);
  if stamp at time zone 'America/Chicago'<>local_stamp then raise exception 'This Central Time does not exist because clocks move forward. Choose another time'; end if;
  if p_require_future and stamp<=p_after then raise exception 'Choose a future send time or Send now'; end if;
  return stamp;
 end if;
 if kind is null or kind not in ('daily','weekly') then raise exception 'Choose a valid delivery schedule'; end if;
 if coalesce(p_schedule->>'local_time','') !~ '^([01]\d|2[0-3]):[0-5]\d$' then raise exception 'Choose a valid Central time'; end if;
 local_time=(p_schedule->>'local_time')::time;
 select coalesce(array_agg(distinct d::smallint),'{}') into days from jsonb_array_elements_text(coalesce(p_schedule->'weekdays','[]')) d;
 if kind='weekly' and (cardinality(days)=0 or exists(select 1 from unnest(days) d where d not between 0 and 6)) then raise exception 'Choose at least one valid weekday'; end if;
 return public.next_message_occurrence(p_after,local_time,days,kind='daily');
end $$;

create function public.preview_notification_schedule(p_schedule jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.profiles where id=auth.uid() and not archived and approval_status='approved' and role in ('client','admin')) then raise exception 'Access denied'; end if;
 return jsonb_build_object('next_at',public.resolve_notification_schedule(p_schedule),'timezone','America/Chicago');
end $$;

create function public.save_notification_message(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid=(p_input->>'workspace_id')::uuid; mid uuid=nullif(p_input->>'id','')::uuid;
 schedule jsonb=p_input->'schedule'; kind text=schedule->>'kind'; instant timestamptz;
 draft boolean=coalesce((p_input->>'draft')::boolean,false); m public.client_messages; old_status text;
 recipients uuid[]; days smallint[];
begin
 if w is null or not public.manages(w) then raise exception 'Access denied'; end if;
 if mid is not null then
  select * into m from public.client_messages where id=mid for update;
  if m.id is null or m.workspace_id<>w or m.status not in ('draft','paused','active','scheduled') then raise exception 'Only a draft or active schedule can be edited'; end if;
  old_status=m.status;
  if draft and old_status<>'draft' then raise exception 'Only new messages and drafts can be saved as drafts'; end if;
 end if;
 instant=public.resolve_notification_schedule(schedule,clock_timestamp(),true);
 select coalesce(array_agg(distinct v::uuid),'{}') into recipients from jsonb_array_elements_text(coalesce(p_input->'recipient_ids','[]')) v;
 select coalesce(array_agg(distinct v::smallint),'{}') into days from jsonb_array_elements_text(coalesce(schedule->'weekdays','[]')) v;
 mid=public.save_client_message(mid,w,p_input->>'title',p_input->>'body',p_input->>'recipient_mode',recipients,
  case when kind='now' then 'once' else kind end,case when kind in ('now','once') then instant end,
  case when kind in ('daily','weekly') then (schedule->>'local_time')::time end,days,draft);
 update public.client_messages set send_on_publish=kind='now',
  status=case when old_status='paused' then 'paused' else status end,
  next_at=case when old_status='paused' or draft then null else instant end
 where id=mid returning * into m;
 return to_jsonb(m);
end $$;

create or replace function public.set_message_status(p_id uuid,p_status text) returns void
language plpgsql security definer set search_path='' as $$
declare m public.client_messages; upcoming timestamptz; schedule jsonb;
begin
 select * into m from public.client_messages where id=p_id for update;
 if m.id is null or not public.manages(m.workspace_id) then raise exception 'Access denied'; end if;
 if p_status is null or p_status not in ('active','paused','cancelled') or m.status in ('completed','cancelled') then raise exception 'Invalid message status'; end if;
 if p_status='active' then
  schedule=jsonb_build_object('kind',case when m.send_on_publish then 'now' else m.schedule_kind end,
   'scheduled_local',to_char(m.scheduled_at at time zone 'America/Chicago','YYYY-MM-DD"T"HH24:MI'),
   'local_time',to_char(m.local_time,'HH24:MI'),'weekdays',to_jsonb(m.weekdays));
  upcoming=public.resolve_notification_schedule(schedule);
  update public.client_messages set status=case when schedule_kind='once' then 'scheduled' else 'active' end,next_at=upcoming,updated_at=clock_timestamp() where id=p_id;
 else
  update public.client_messages set status=p_status,next_at=null,updated_at=clock_timestamp() where id=p_id;
 end if;
end $$;

-- Repair only active recurring rows; paused periods are never replayed.
update public.client_messages set next_at=public.resolve_notification_schedule(jsonb_build_object('kind',schedule_kind,'local_time',to_char(local_time,'HH24:MI'),'weekdays',to_jsonb(weekdays))),updated_at=clock_timestamp()
where status='active' and schedule_kind in ('daily','weekly') and next_at is null;

create function public.notification_unread_count() returns bigint language sql stable security definer set search_path='' as $$
 select count(*) from public.inbox_notifications n join public.profiles p on p.id=n.user_id
 where n.user_id=auth.uid() and not p.archived and n.read_at is null and n.resolved_at is null
 and ((p.role='bidder' and n.kind='message') or (p.role='admin' and n.kind='client_signup'))
$$;

create function public.notification_by_id(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 select to_jsonb(n) into result from public.inbox_notifications n join public.profiles p on p.id=n.user_id
 where n.id=p_id and n.user_id=auth.uid() and not p.archived and ((p.role='bidder' and n.kind='message') or (p.role='admin' and n.kind='client_signup'));
 if result is null then raise exception 'Notification not found'; end if;
 return result;
end $$;

create function public.notification_page(p_kind text,p_workspace uuid default null,p_status text default null,p_cursor jsonb default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare results jsonb; rows jsonb; cursor_stamp timestamptz=(p_cursor->>'created_at')::timestamptz; cursor_id uuid=(p_cursor->>'id')::uuid; actor public.profiles; allowed_workspaces uuid[];
begin
 select * into actor from public.profiles where id=auth.uid() and not archived;
 if actor.id is null then raise exception 'Access denied'; end if;
 if p_kind='inbox' then
  if actor.role not in ('bidder','admin') then raise exception 'Access denied'; end if;
  select coalesce(jsonb_agg(to_jsonb(n) order by n.created_at desc,n.id desc),'[]') into results from (
   select * from public.inbox_notifications where user_id=actor.id and kind=case when actor.role='admin' then 'client_signup' else 'message' end
   and (p_cursor is null or (created_at,id)<(cursor_stamp,cursor_id)) order by created_at desc,id desc limit 51
  ) n;
 elsif p_kind='messages' then
  if actor.role not in ('client','admin') or actor.approval_status<>'approved' or (p_workspace is not null and not public.manages(p_workspace)) then raise exception 'Access denied'; end if;
  select coalesce(array_agg(id),'{}') into allowed_workspaces from public.workspaces where (actor.role='admin' or owner_id=actor.id) and (p_workspace is null or id=p_workspace);
  select coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('latest_publication',(
   select jsonb_build_object('published_at',o.published_at,'recipient_count',o.recipient_count) from public.message_occurrences o where o.message_id=m.id order by o.published_at desc,o.id desc limit 1
  )) order by m.created_at desc,m.id desc),'[]') into results from (
   select * from public.client_messages where workspace_id=any(allowed_workspaces)
    and (p_status is null or p_status='all' or status=p_status) and (p_cursor is null or (created_at,id)<(cursor_stamp,cursor_id)) order by created_at desc,id desc limit 51
  ) m;
 else raise exception 'Choose a valid notification list'; end if;
 select coalesce(jsonb_agg(v order by ord),'[]') into rows from jsonb_array_elements(results) with ordinality t(v,ord) where ord<=50;
 return jsonb_build_object('rows',rows,'next_cursor',case when jsonb_array_length(results)>50 then jsonb_build_object('created_at',rows->49->>'created_at','id',rows->49->>'id') end,
  'unread_count',public.notification_unread_count());
end $$;

create function public.notification_device_enabled(p_endpoint text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.push_subscriptions s join public.profiles p on p.id=s.user_id where s.user_id=auth.uid() and s.endpoint=p_endpoint and not p.archived)
$$;

create or replace function public.queue_notification_pushes() returns integer language plpgsql security definer set search_path='' as $$
declare count_rows integer;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 -- Exclude durable attempts BEFORE the bound. Rescanning also sees late commits.
 insert into public.push_attempts(notification_id,subscription_id)
 select n.id,s.id from public.inbox_notifications n join public.push_subscriptions s on s.user_id=n.user_id join public.profiles p on p.id=n.user_id
 where n.created_at>=s.created_at and n.resolved_at is null and not p.archived
 and ((n.kind='message' and p.role='bidder' and exists(select 1 from public.bidders b join public.workspaces w on w.id=b.workspace_id join public.profiles owner on owner.id=w.owner_id where b.user_id=p.id and not b.archived and not owner.archived and owner.approval_status='approved')) or (n.kind='client_signup' and p.role='admin'))
 and not exists(select 1 from public.push_attempts a where a.notification_id=n.id and a.subscription_id=s.id)
 order by n.created_at,n.id,s.id limit 500 on conflict do nothing;
 get diagnostics count_rows=row_count; return count_rows;
end $$;

create or replace function public.claim_push_attempts(p_limit integer default 100)
returns table(attempt_id uuid,lease_id uuid,notification_id uuid,endpoint text,p256dh text,auth_secret text,title text,body text,user_id uuid)
language plpgsql security definer set search_path='' as $$
declare lease uuid=gen_random_uuid();
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 return query with picked as (
  select a.id from public.push_attempts a join public.inbox_notifications n on n.id=a.notification_id
  join public.push_subscriptions s on s.id=a.subscription_id and s.user_id=n.user_id join public.profiles p on p.id=n.user_id
  where a.delivered_at is null and a.next_attempt_at<=clock_timestamp() and (a.lease_until is null or a.lease_until<clock_timestamp())
   and n.created_at>=s.created_at and not p.archived and n.resolved_at is null
   and ((n.kind='message' and p.role='bidder' and exists(select 1 from public.bidders b join public.workspaces w on w.id=b.workspace_id join public.profiles owner on owner.id=w.owner_id where b.user_id=p.id and not b.archived and not owner.archived and owner.approval_status='approved')) or (n.kind='client_signup' and p.role='admin'))
  order by a.next_attempt_at,a.id for update of a skip locked limit least(greatest(p_limit,1),5)
 ), leased as (
  update public.push_attempts a set lease_id=lease,lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1 from picked where a.id=picked.id returning a.*
 ) select l.id,l.lease_id,n.id,s.endpoint,s.p256dh,s.auth_secret,n.title,n.body,n.user_id from leased l
 join public.inbox_notifications n on n.id=l.notification_id join public.push_subscriptions s on s.id=l.subscription_id and s.user_id=n.user_id;
end $$;

create or replace function public.finish_push_attempt(p_attempt uuid,p_lease uuid,p_error text,p_expired boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare a public.push_attempts;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 select * into a from public.push_attempts where id=p_attempt for update;
 if a.id is null or a.delivered_at is not null or p_lease is null or a.lease_id is null or a.lease_id<>p_lease then return; end if;
 if p_error is null then update public.push_attempts set delivered_at=clock_timestamp(),lease_id=null,lease_until=null,last_error=null where id=a.id;
 elsif p_expired then delete from public.push_subscriptions where id=a.subscription_id;
 else update public.push_attempts set next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,30*(2^least(attempts,7))::integer)),lease_id=null,lease_until=null,last_error=left(p_error,500) where id=a.id; end if;
end $$;

revoke all on function public.resolve_notification_schedule(jsonb,timestamptz,boolean),public.preview_notification_schedule(jsonb),public.save_notification_message(jsonb),public.notification_page(text,uuid,text,jsonb),public.notification_by_id(uuid),public.notification_unread_count(),public.notification_device_enabled(text) from public,anon;
grant execute on function public.resolve_notification_schedule(jsonb,timestamptz,boolean),public.preview_notification_schedule(jsonb),public.save_notification_message(jsonb),public.notification_page(text,uuid,text,jsonb),public.notification_by_id(uuid),public.notification_unread_count(),public.notification_device_enabled(text) to authenticated;
grant execute on function public.resolve_notification_schedule(jsonb,timestamptz,boolean) to service_role;

create or replace function public.process_due_messages(p_now timestamptz default clock_timestamp(),p_limit integer default 100) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.client_messages; due_stamp timestamptz; latest_due date; local_today date; occurrence uuid; sent integer=0; recipients integer; begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 for m in select * from public.client_messages where status in ('scheduled','active') and next_at<=p_now order by next_at,id for update skip locked limit least(greatest(p_limit,1),500) loop
  due_stamp=m.next_at;
  if m.schedule_kind='once' then
   insert into public.message_occurrences(message_id,scheduled_for) values(m.id,due_stamp) on conflict(message_id,scheduled_for) do nothing returning id into occurrence;
   if occurrence is not null then
    insert into public.inbox_notifications(occurrence_id,user_id,title,body)
    select occurrence,b.user_id,m.title,m.body from public.bidders b join public.profiles p on p.id=b.user_id join public.profiles owner on owner.id=(select owner_id from public.workspaces where id=m.workspace_id)
    where b.workspace_id=m.workspace_id and not b.archived and not p.archived and not owner.archived and owner.approval_status='approved' and (m.recipient_mode='all' or b.user_id=any(m.recipient_ids)) on conflict do nothing;
    get diagnostics recipients=row_count; update public.message_occurrences set recipient_count=recipients where id=occurrence; sent=sent+1;
   end if;
   update public.client_messages set status='completed',next_at=null,updated_at=p_now where id=m.id;
  else
   local_today=(p_now at time zone 'America/Chicago')::date;
   if m.schedule_kind='daily' then latest_due=local_today; if public.message_occurrence_at(latest_due,m.local_time)>p_now then latest_due=latest_due-1; end if;
   else select max(d::date) into latest_due from generate_series(local_today-7,local_today,interval '1 day') d where extract(dow from d)::integer=any(m.weekdays) and public.message_occurrence_at(d::date,m.local_time)<=p_now; end if;
   due_stamp=public.message_occurrence_at(latest_due,m.local_time);
   insert into public.message_occurrences(message_id,scheduled_for) values(m.id,due_stamp) on conflict(message_id,scheduled_for) do nothing returning id into occurrence;
   if occurrence is not null then
    insert into public.inbox_notifications(occurrence_id,user_id,title,body)
    select occurrence,b.user_id,m.title,m.body from public.bidders b join public.profiles p on p.id=b.user_id join public.profiles owner on owner.id=(select owner_id from public.workspaces where id=m.workspace_id)
    where b.workspace_id=m.workspace_id and not b.archived and not p.archived and not owner.archived and owner.approval_status='approved' and (m.recipient_mode='all' or b.user_id=any(m.recipient_ids)) on conflict do nothing;
    get diagnostics recipients=row_count; update public.message_occurrences set recipient_count=recipients where id=occurrence; sent=sent+1;
   end if;
   update public.client_messages set next_at=public.next_message_occurrence(p_now,m.local_time,m.weekdays,m.schedule_kind='daily'),updated_at=p_now where id=m.id;
  end if;
 end loop;
 return jsonb_build_object('occurrences',sent);
end $$;


