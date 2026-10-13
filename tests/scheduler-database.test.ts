import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema net; create schema vault;
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
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  for (const file of [
    "notifications-function.sql",
    "storage-cleanup-function.sql",
  ])
    await db.exec(readFileSync(`supabase/scheduler/${file}`, "utf8"));
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(
    "reset role; delete from public.scheduler_http_calls; delete from vault.decrypted_secrets; delete from public.storage_cleanup_tasks",
  );
});
const invoke = () =>
  db.query<{ request: number }>(
    "select public.invoke_notification_worker() request",
  );
const calls = async () =>
  (await db.query("select * from public.scheduler_http_calls")).rows;

it.each(["url", "secret"])(
  "fails closed before calling notifications when scheduler %s is missing",
  async (missing) => {
    const available = missing === "url" ? "secret" : "url";
    await db.query(
      "insert into vault.decrypted_secrets values($1,'configured')",
      [`notification_worker_${available}`],
    );
    await expect(invoke()).rejects.toThrow(/not configured/i);
    expect(await calls()).toEqual([]);
  },
);
it.each([false, true])(
  "dispatches notifications with the configured endpoint, authentication and optional bypass=%s",
  async (bypass) => {
    await db.exec(
      "insert into vault.decrypted_secrets values('notification_worker_url','https://scheduler.test/api/cron/notifications'),('notification_worker_secret','private-test-secret')",
    );
    if (bypass)
      await db.exec(
        "insert into vault.decrypted_secrets values('notification_worker_bypass','preview-bypass')",
      );
    expect((await invoke()).rows).toEqual([{ request: 17 }]);
    expect(await calls()).toEqual([
      {
        method: "POST",
        url: "https://scheduler.test/api/cron/notifications",
        headers: {
          authorization: "Bearer private-test-secret",
          ...(bypass ? { "x-vercel-protection-bypass": "preview-bypass" } : {}),
        },
        body: {},
        timeout: 55000,
      },
    ]);
  },
);
it.each(["anon", "authenticated"])(
  "denies %s execution of both scheduler entry points",
  async (role) => {
    await db.exec(`set role ${role}`);
    for (const fn of ["invoke_notification_worker", "invoke_storage_cleanup"])
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
