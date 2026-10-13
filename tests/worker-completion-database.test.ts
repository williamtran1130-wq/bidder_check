import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
let db: PGlite;
let operation: string;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);alter table storage.objects enable row level security;`);
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  await db.exec(
    "insert into auth.users(id,email) values('10000000-0000-4000-8000-000000000001','worker@test.invalid')",
  );
  operation = (
    await db.query<{ id: string }>(
      "insert into public.bid_purge_operations(actor_id,scope,targets,count,completed_at) values('10000000-0000-4000-8000-000000000001','all','[]',2,now()) returning id",
    )
  ).rows[0].id;
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(
    "reset role;delete from public.storage_cleanup_tasks;set role service_role;select set_config('request.jwt.claim.role','service_role',false)",
  );
});
const tasks = async () =>
  (
    await db.query<{ id: string; lease_id: string }>(
      "insert into public.storage_cleanup_tasks(operation_id,storage_path,lease_id,lease_until) values($1,'first',gen_random_uuid(),now()+interval '2 minutes'),($1,'second',gen_random_uuid(),now()+interval '2 minutes') returning id,lease_id",
      [operation],
    )
  ).rows;
const finish = (ids: string[], leases: (string | null)[], success = true) =>
  db.query(
    "select public.finish_storage_cleanup_batch($1::uuid[],$2::uuid[],$3)",
    [ids, leases, success],
  );
it("acknowledges only matching leases and preserves the five-minute second pass", async () => {
  const [first, second] = await tasks();
  await finish(
    [first.id, second.id],
    [first.lease_id, "00000000-0000-4000-8000-000000000099"],
  );
  const state = (
    await db.query<{
      id: string;
      first_removed_at: unknown;
      completed_at: unknown;
      storage_path: string;
      wait: number;
    }>(
      "select id,first_removed_at,completed_at,storage_path,extract(epoch from next_attempt_at-first_removed_at)::float8 wait from public.storage_cleanup_tasks order by storage_path",
    )
  ).rows;
  expect(state[0]).toMatchObject({
    id: first.id,
    completed_at: null,
    storage_path: "first",
    wait: 300,
  });
  expect(state[0].first_removed_at).not.toBeNull();
  expect(state[1]).toMatchObject({
    id: second.id,
    first_removed_at: null,
    completed_at: null,
  });
  const early = (
    await db.query("select * from public.claim_storage_cleanup($1,50)", [
      operation,
    ])
  ).rows;
  expect(early).toEqual([]);
  await db.query(
    "update public.storage_cleanup_tasks set next_attempt_at=now()-interval '1 second' where id=$1",
    [first.id],
  );
  const reclaimed = (
    await db.query<{ id: string; lease_id: string }>(
      "select * from public.claim_storage_cleanup($1,50)",
      [operation],
    )
  ).rows[0];
  await finish([first.id], [first.lease_id]);
  expect(
    (
      await db.query<{ completed_at: unknown }>(
        "select completed_at from public.storage_cleanup_tasks where id=$1",
        [first.id],
      )
    ).rows[0].completed_at,
  ).toBeNull();
  await finish([reclaimed.id], [reclaimed.lease_id]);
  expect(
    (
      await db.query(
        "select storage_path,completed_at is not null done from public.storage_cleanup_tasks where id=$1",
        [first.id],
      )
    ).rows,
  ).toEqual([{ storage_path: null, done: true }]);
});
it("records uncertain removal as retryable failure without claiming successful per-object deletion", async () => {
  const pending = await tasks();
  await finish(
    pending.map((t) => t.id),
    pending.map((t) => t.lease_id),
    false,
  );
  const state = (
    await db.query<{
      first_removed_at: unknown;
      completed_at: unknown;
      lease_id: string | null;
      last_error: string | null;
      storage_path: string | null;
    }>(
      "select first_removed_at,completed_at,lease_id,last_error,storage_path from public.storage_cleanup_tasks",
    )
  ).rows;
  expect(
    state.every(
      (t) =>
        t.first_removed_at === null &&
        t.completed_at === null &&
        t.lease_id === null &&
        t.storage_path !== null &&
        String(t.last_error).includes("retry pending"),
    ),
  ).toBe(true);
});
it("rejects malformed batch identities before changing any task", async () => {
  const pending = await tasks();
  await expect(
    finish(
      pending.map((t) => t.id),
      [pending[0].lease_id],
    ),
  ).rejects.toThrow(/batch/i);
  await expect(finish([pending[0].id], [null])).rejects.toThrow(/batch/i);
  expect(
    (
      await db.query<{ first_removed_at: unknown }>(
        "select first_removed_at from public.storage_cleanup_tasks",
      )
    ).rows.every((t) => t.first_removed_at === null),
  ).toBe(true);
});
it.each(["anon", "authenticated"])(
  "denies %s batch completion against the full schema",
  async (role) => {
    await db.exec(`reset role;set role ${role}`);
    await expect(finish([], [])).rejects.toThrow(/permission/i);
  },
);
