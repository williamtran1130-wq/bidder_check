-- Retire notifications while preserving account approval, provisioning and storage workers.
begin;

-- These integrations are optional in local/test databases.
do $$
declare job record;
begin
  if to_regclass('cron.job') is not null then
    for job in execute 'select jobid from cron.job where jobname = ''bidder-check-notifications'''
    loop
      perform cron.unschedule(job.jobid);
    end loop;
  end if;
end $$;

drop function if exists public.invoke_notification_worker();
drop trigger if exists resolve_client_signup_alerts on public.profiles;
drop function if exists public.resolve_client_signup_alerts();
drop trigger if exists reset_reassigned_push_device on public.push_subscriptions;
drop function if exists public.reset_reassigned_push_device();

-- Public signup remains pending; People retains the approval workflow.
create or replace function public.on_auth_user() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  inv public.invitations;
  provision public.client_provisions;
  v_display_name text;
begin
  select * into inv from public.invitations
    where email=lower(new.email) and accepted_at is null for update;
  if inv.id is not null then
    if new.id<>inv.id or inv.expires_at<=now() then
      raise exception 'This email is reserved for a managed account';
    end if;
    if not exists(select 1 from public.workspaces w join public.profiles p on p.id=w.owner_id
      where w.id=inv.workspace_id and not p.archived and p.approval_status='approved') then
      raise exception 'Workspace is inactive';
    end if;
    insert into public.profiles(id,email,display_name,role)
      values(new.id,lower(new.email),inv.display_name,'bidder');
    insert into public.bidders(user_id,workspace_id,default_rate_cents)
      values(new.id,inv.workspace_id,inv.default_rate_cents);
    if new.email_confirmed_at is not null then
      update public.invitations set accepted_at=now() where id=inv.id;
    end if;
  else
    -- Auth app metadata is server-only, while user metadata is signup-controlled.
    if new.raw_app_meta_data->>'bidder_provisioning_id' is not null
       or new.raw_user_meta_data->>'bidder_provisioning_id' is not null then
      raise exception 'Account reservation is missing or already used';
    end if;
    select * into provision from public.client_provisions where email=lower(new.email) for update;
    if provision.id is not null and (provision.id<>new.id or provision.consumed_at is not null) then
      raise exception 'This email is reserved for a managed account';
    end if;
    v_display_name := left(coalesce(new.raw_user_meta_data->>'display_name',split_part(new.email,'@',1)),100);
    insert into public.profiles(id,email,display_name,role,approval_status)
      values(new.id,lower(new.email),coalesce(provision.display_name,v_display_name),'client',case when provision.id is not null then 'approved' else 'pending' end);
    insert into public.workspaces(owner_id) values(new.id);
    if provision.id is not null then
      update public.client_provisions set consumed_at=clock_timestamp() where id=provision.id;
    end if;
  end if;
  return new;
end $$;

-- Drop each retired API explicitly, before its dependent relation types.
drop function if exists public.notification_page(text,uuid,text,jsonb);
drop function if exists public.notification_by_id(uuid);
drop function if exists public.notification_unread_count();
drop function if exists public.notification_device_enabled(text);
drop function if exists public.mark_notification_read(uuid,boolean);
drop function if exists public.save_notification_message(jsonb);
drop function if exists public.preview_notification_schedule(jsonb);
drop function if exists public.set_message_status(uuid,text);
drop function if exists public.process_due_messages(timestamptz,integer);
drop function if exists public.claim_push_attempts(integer);
drop function if exists public.finish_push_attempt(uuid,uuid,text,boolean);
drop function if exists public.queue_notification_pushes();
drop function if exists public.save_push_subscription(text,text,text);
drop function if exists public.delete_push_subscription(text);
drop function if exists public.delete_all_push_subscriptions();
drop function if exists public.save_client_message(uuid,uuid,text,text,text,uuid[],text,timestamptz,time,smallint[],boolean);
drop function if exists public.resolve_notification_schedule(jsonb,timestamptz,boolean);
drop function if exists public.next_message_occurrence(timestamptz,time,smallint[],boolean);
drop function if exists public.message_occurrence_at(date,time);

-- Child-first deletion removes notification data, policies, indexes and table grants.
drop table public.push_attempts;
drop table public.push_subscriptions;
drop table public.inbox_notifications;
drop table public.message_occurrences;
drop table public.client_messages;

-- Erase only notification worker configuration, leaving storage cleanup secrets intact.
do $$ begin
  if to_regclass('vault.secrets') is not null then
    execute 'delete from vault.secrets where name in (''notification_worker_url'',''notification_worker_secret'',''notification_worker_bypass'')';
  end if;
end $$;

commit;
