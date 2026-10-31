import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema net; create schema vault; create schema cron;
    create table cron.job(jobid bigint,jobname text);
    insert into cron.job values(1,'bidder-check-notifications'),(2,'bidder-check-storage-cleanup'),(3,'other-job');
    create function cron.unschedule(bigint) returns boolean language sql as $$ delete from cron.job where jobid=$1 returning true $$;
    create table vault.secrets(name text);
    insert into vault.secrets values('notification_worker_url'),('notification_worker_secret'),('notification_worker_bypass'),('storage_cleanup_secret');
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
    alter table storage.objects enable row level security;
    create table vault.decrypted_secrets(name text,decrypted_secret text);
    create table public.scheduler_http_calls(method text,url text,headers jsonb,body jsonb,timeout integer);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$ insert into public.scheduler_http_calls values('POST',url,headers,body,timeout_milliseconds) returning 17::bigint $$;
    create function net.http_get(url text,headers jsonb,timeout_milliseconds integer) returns bigint language sql as $$ insert into public.scheduler_http_calls values('GET',url,headers,null,timeout_milliseconds) returning 23::bigint $$;`);
  for (const file of readdirSync("supabase/migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (file === "202610310003_retire_notifications.sql") {
      await db.exec(`insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000099','retirement@test.invalid');
        insert into public.client_messages(workspace_id,created_by,title,body,recipient_mode,schedule_kind,scheduled_at)
          select id,owner_id,'Retired schedule','Retired content','all','once',now() from public.workspaces;
        insert into public.message_occurrences(message_id,scheduled_for) select id,now() from public.client_messages;
        insert into public.inbox_notifications(occurrence_id,user_id,title,body) select id,'00000000-0000-4000-8000-000000000099','Retired notice','Retired content' from public.message_occurrences;
        insert into public.push_subscriptions(user_id,endpoint,p256dh,auth_secret) values('00000000-0000-4000-8000-000000000099','https://push.test.invalid/retired','key','secret');
        insert into public.push_attempts(notification_id,subscription_id) select n.id,s.id from public.inbox_notifications n cross join public.push_subscriptions s;`);
    }
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
  await db.exec(readFileSync("supabase/scheduler/storage-cleanup-function.sql", "utf8"));
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(
    "reset role; delete from public.scheduler_http_calls; delete from vault.decrypted_secrets; delete from public.storage_cleanup_tasks",
  );
});
const calls = async () =>
  (await db.query("select * from public.scheduler_http_calls")).rows;

it("retires the notification scheduler and tables while preserving storage cleanup", async () => {
  const result = await db.query("select to_regprocedure('public.invoke_notification_worker()') retired, to_regclass('public.inbox_notifications') inbox, to_regclass('public.storage_cleanup_tasks') cleanup");
  expect(result.rows).toEqual([{ retired: null, inbox: null, cleanup: 'storage_cleanup_tasks' }]);
  expect((await db.query("select jobname from cron.job order by jobid")).rows).toEqual([{ jobname: "bidder-check-storage-cleanup" }, { jobname: "other-job" }]);
  expect((await db.query("select name from vault.secrets")).rows).toEqual([{ name: "storage_cleanup_secret" }]);
  expect((await db.query("select approval_status from public.profiles where email='retirement@test.invalid'")).rows).toEqual([{ approval_status: "pending" }]);
  for (const table of ["client_messages", "message_occurrences", "inbox_notifications", "push_subscriptions", "push_attempts"]) {
    expect((await db.query("select to_regclass($1) retired", [`public.${table}`])).rows).toEqual([{ retired: null }]);
  }
});
it.each(["anon", "authenticated"])(
  "denies %s execution of the storage scheduler entry point",
  async (role) => {
    await db.exec(`set role ${role}`);
    for (const fn of ["invoke_storage_cleanup"])
      await expect(db.query(`select public.${fn}()`)).rejects.toThrow(
        /permission denied/i,
      );
    await db.exec("reset role");
    expect(await calls()).toEqual([]);
  },
);
it("does not schedule storage cleanup when there is no due work", async () => {
  expect(
    (await db.query("select public.invoke_storage_cleanup() request")).rows,
  ).toEqual([{ request: null }]);
  expect(await calls()).toEqual([]);
});
