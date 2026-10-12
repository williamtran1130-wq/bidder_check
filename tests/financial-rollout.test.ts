import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

let db: PGlite;
const client = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const bidder = "00000000-0000-4000-8000-000000000003";
let workspace: string, resume: string, bid: string;
async function asUser(id: string) {
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false); select set_config('request.jwt.claim.role','authenticated',false);`,
  );
}
async function approveBidAsClient(bidId: string) {
  await asUser(client);
  const version = (
    await db.query<{ version: number }>(
      "select version from public.bids where id=$1",
      [bidId],
    )
  ).rows[0].version;
  await db.query("select public.review_bid($1,'approved',null,$2)", [
    bidId,
    version,
  ]);
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create schema storage;
 create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
 alter table storage.objects enable row level security;
 grant usage on schema auth, storage to authenticated, service_role;
 grant all on storage.objects to authenticated,service_role;
 `);
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql") && f <= "202610120002_financial_reads.sql")
    .sort()) {
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
  await db.query(
    "insert into auth.users(id,email) values ($1,'client@test.com'),($2,'other@test.com')",
    [client, other],
  );
  await db.exec(`do $$ begin
    if exists(select 1 from information_schema.columns where table_name='profiles' and column_name='approval_status') then
      update public.profiles set approval_status='approved';
    end if;
  end $$;`);
  await asUser(client);
  workspace = (
    await db.query<{ id: string }>("select id from public.workspaces")
  ).rows[0].id;
  await db.query(
    "select public.invite_bidder($1,'bidder@test.com','Jordan',125)",
    [workspace],
  );
  await db.exec("reset role");
  await db.query(
    "update public.invitations set id=$1 where email='bidder@test.com'",
    [bidder],
  );
  await db.query(
    "insert into auth.users(id,email,raw_app_meta_data) select $1,'bidder@test.com',jsonb_build_object('bidder_provisioning_id',id) from public.invitations where email='bidder@test.com'",
    [bidder],
  );
  await asUser(client);
  const profileId = (
    await db.query<{ id: string }>(
      "select public.save_candidate_profile(null,$1,'ENG-01','Jordan','','','Instructions') id",
      [workspace],
    )
  ).rows[0].id;
  resume = (
    await db.query<{ id: string }>(
      "select public.save_resume_assignment(null,$1,$2,'jordan@test.com','555-1000',null,null) as id",
      [profileId, bidder],
    )
  ).rows[0].id;
  const resumeUpload = (
    await db.query<{ id: string }>(
      "select public.prepare_file('resume',$1,'resume.pdf','application/pdf',100) id",
      [resume],
    )
  ).rows[0].id;
  await db.exec("reset role; set role service_role");
  await db.query("select public.finalize_verified_file($1,$2,$3)", [
    resumeUpload,
    "b".repeat(64),
    client,
  ]);
  await asUser(bidder);
  bid = (
    await db.query<{ id: string }>(
      "select public.save_bid(null,$1,'Acme','Engineer','https://example.com/jobs?id=1&utm_source=x','LinkedIn','remote','open') as id",
      [resume],
    )
  ).rows[0].id;
  await approveBidAsClient(bid);
  await asUser(bidder);
}, 60000);
afterAll(async () => { await db.close(); });
it("compatibility deployment preserves legacy manager rows before the application cutover", async () => {
  await asUser(client);
  const old = (await db.query<{ value: { rows: Record<string,unknown>[] } }>("select list_bids('{}') value")).rows[0].value;
  expect(old.rows[0]).toHaveProperty("rate_cents");
});
it("the additive v2 endpoint already exposes safe rows to new application callers", async () => {
  await asUser(bidder);
  const safe = (await db.query<{ value: { rows: Record<string,unknown>[] } }>("select list_bids_v2('{}') value")).rows[0].value;
  expect(safe.rows).toHaveLength(1);
  expect(safe.rows[0]).not.toHaveProperty("rate_cents");
});
