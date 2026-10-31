import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const owner = "40000000-0000-4000-8000-000000000001";
const bidder = "40000000-0000-4000-8000-000000000002";
const other = "40000000-0000-4000-8000-000000000003";
let db: PGlite, workspace: string, profile: string, resume: string, bid: string;
async function actor(id = owner) {
  await db.exec("reset role; set role authenticated");
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",
    [id],
  );
}
async function service() {
  await db.exec(
    "reset role; set role service_role; select set_config('request.jwt.claim.role','service_role',false)",
  );
}
async function age(file: string, hours = 169) {
  // Only the fixture owner can bypass the immutable timestamp to simulate elapsed time.
  await db.exec(
    "reset role; alter table public.files disable trigger stamp_verified_file",
  );
  await db.query(
    "update public.files set finalized_at=clock_timestamp()-make_interval(hours=>$2) where id=$1",
    [file, hours],
  );
  await db.exec("alter table public.files enable trigger stamp_verified_file");
  await service();
}
async function proof(hash = "a".repeat(64), target = bid) {
  await actor();
  const id = (
    await db.query<{ id: string }>(
      "select public.prepare_file('screenshot',$1,'proof.png','image/png',100) id",
      [target],
    )
  ).rows[0].id;
  await service();
  await db.query("select public.finalize_verified_file_v2($1,$2,$3,'{}')", [
    id,
    hash,
    owner,
  ]);
  return id;
}
async function statement<T>(fn: () => Promise<T>) {
  await db.exec("savepoint attempt");
  try {
    const result = await fn();
    await db.exec("release savepoint attempt");
    return result;
  } catch (error) {
    await db.exec("rollback to savepoint attempt; release savepoint attempt");
    throw error;
  }
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb); alter table storage.objects enable row level security;
    grant usage on schema auth,storage to authenticated,service_role; grant all on storage.objects to authenticated,service_role;`);
  for (const f of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${f}`, "utf8"));
  await db.query(
    "insert into auth.users(id,email) values($1,'owner@expiry.test'),($2,'bidder@expiry.test'),($3,'other@expiry.test')",
    [owner, bidder, other],
  );
  await db.exec("update public.profiles set approval_status='approved'");
  workspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [owner],
    )
  ).rows[0].id;
  await db.query("update public.profiles set role='bidder' where id=$1", [
    bidder,
  ]);
  await db.query(
    "insert into public.bidders(user_id,workspace_id,default_rate_cents) values($1,$2,125)",
    [bidder, workspace],
  );
  await actor();
  profile = (
    await db.query<{ id: string }>(
      "select public.save_candidate_profile(null,$1,'EXP','Candidate','','','') id",
      [workspace],
    )
  ).rows[0].id;
  resume = (
    await db.query<{ id: string }>(
      "select public.save_resume_assignment(null,$1,$2,'candidate@expiry.test','555-1000',null,null) id",
      [profile, bidder],
    )
  ).rows[0].id;
  const pdf = (
    await db.query<{ id: string }>(
      "select public.prepare_file('resume',$1,'resume.pdf','application/pdf',100) id",
      [resume],
    )
  ).rows[0].id;
  await service();
  await db.query("select public.finalize_verified_file($1,$2,$3)", [
    pdf,
    "c".repeat(64),
    owner,
  ]);
}, 60000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("reset role; begin");
  await actor();
  bid = (
    await db.query<{ id: string }>(
      "select public.save_bid(null,$1,'Expiry Company','Engineer','https://expiry.test/job','Board','remote','open') id",
      [resume],
    )
  ).rows[0].id;
});
afterEach(async () => {
  await db.exec("rollback; reset role");
});

it("prevents direct long-lived screenshot signing while allowing the uploader to verify an unfinished upload", async () => {
  const file = await proof();
  await service();
  await db.exec("update public.file_retention_settings set enabled=true");
  const path = (
    await db.query<{ storage_path: string }>(
      "select storage_path from public.files where id=$1",
      [file],
    )
  ).rows[0].storage_path;
  await db.query(
    "insert into storage.objects(bucket_id,name) values('private-files',$1)",
    [path],
  );
  await actor();
  expect(
    (await db.query("select name from storage.objects where name=$1", [path]))
      .rows,
  ).toHaveLength(0);
  const pending = (
    await db.query<{ id: string }>(
      "select public.prepare_file('screenshot',$1,'proof.png','image/png',100) id",
      [bid],
    )
  ).rows[0].id;
  await service();
  const unfinishedPath = (
    await db.query<{ storage_path: string }>(
      "select storage_path from public.files where id=$1",
      [pending],
    )
  ).rows[0].storage_path;
  await db.query(
    "insert into storage.objects(bucket_id,name) values('private-files',$1)",
    [unfinishedPath],
  );
  await actor();
  expect(
    (
      await db.query("select name from storage.objects where name=$1", [
        unfinishedPath,
      ])
    ).rows,
  ).toHaveLength(1);
});
it("keeps expiry transactions small even when an older deployment requests a 500-file batch", async () => {
  await service();
  await db.exec("update public.file_retention_settings set enabled=true");
  await db.query(
    `insert into public.files(id,workspace_id,bidder_id,kind,bid_id,filename,mime,size_bytes,storage_path,created_by,finalized,finalized_at,sha256,review_revision)
    select id,$1::uuid,$2::uuid,'screenshot',$3::uuid,'old.png','image/png',100,$1::text||'/'||$2::text||'/'||id::text,$4,true,clock_timestamp()-interval '169 hours',repeat('a',64),1
    from (select gen_random_uuid() id from generate_series(1,130)) fixture`,
    [workspace, bidder, bid, owner],
  );
  await db.query("select public.process_screenshot_retention(500)");
  expect(
    (await db.query("select id from public.files where bid_id=$1", [bid])).rows,
  ).toHaveLength(30);
});
it("pauses automatic cleanup without reopening old archive writes or direct screenshot signing", async () => {
  const file = await proof();
  await service();
  await db.exec(
    "update public.file_retention_settings set enabled=true; update public.file_retention_settings set enabled=false",
  );
  const path = (
    await db.query<{ storage_path: string }>(
      "select storage_path from public.files where id=$1",
      [file],
    )
  ).rows[0].storage_path;
  await db.query(
    "insert into storage.objects(bucket_id,name) values('private-files',$1)",
    [path],
  );
  await actor();
  expect(
    (await db.query("select name from storage.objects where name=$1", [path]))
      .rows,
  ).toHaveLength(0);
  await expect(
    statement(() => db.query("select public.trash_bid($1,true)", [bid])),
  ).rejects.toThrow(/refresh/i);
});

it("expires only the screenshot and preserves application state, earnings and activity", async () => {
  const file = await proof();
  const before = (
    await db.query(
      "select applied,applied_at,first_applied_at,rate_cents,application_method from public.bids where id=$1",
      [bid],
    )
  ).rows[0];
  await age(file);
  await db.exec("update public.file_retention_settings set enabled=true");
  await db.query("select public.process_screenshot_retention(20)");
  expect(
    (
      await db.query(
        "select applied,applied_at,first_applied_at,rate_cents,application_method from public.bids where id=$1",
        [bid],
      )
    ).rows[0],
  ).toEqual(before);
  expect(
    (
      await db.query<{ evidence_file_id: string | null }>(
        "select evidence_file_id from public.bids where id=$1",
        [bid],
      )
    ).rows[0].evidence_file_id,
  ).toBeNull();
  expect(
    (await db.query("select id from public.files where id=$1", [file])).rows,
  ).toHaveLength(0);
  expect(
    (
      await db.query(
        "select bid_id from public.bid_application_locations where original_file_id=$1",
        [file],
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await db.query(
        "select file_id from public.bid_events where bid_id=$1 and event='applied'",
        [bid],
      )
    ).rows,
  ).toEqual([{ file_id: null }]);
  expect(
    (
      await db.query(
        "select id from public.storage_cleanup_tasks where completed_at is null",
      )
    ).rows.length,
  ).toBeGreaterThan(0);
  await db.query("select public.process_screenshot_retention(20)");
  expect(
    (await db.query("select id from public.bids where id=$1", [bid])).rows,
  ).toHaveLength(1);
});
it("keeps a fresh proof and discovers expired proofs without an existing removal task", async () => {
  const file = await proof();
  await db.exec("update public.file_retention_settings set enabled=true");
  await db.query("select public.process_screenshot_retention(20)");
  expect(
    (await db.query("select id from public.files where id=$1", [file])).rows,
  ).toHaveLength(1);
  await age(file, 168);
  expect(
    (
      await db.query<{ due: boolean }>(
        "select public.has_due_storage_cleanup() due",
      )
    ).rows[0].due,
  ).toBe(true);
});
it("rejects the same proof after expiry and manager correction", async () => {
  const file = await proof();
  await db.exec("update public.file_retention_settings set enabled=true");
  await age(file);
  await db.query("select public.process_screenshot_retention(20)");
  await actor();
  await db.query("select public.set_applied($1,false,null,'Invalid proof')", [
    bid,
  ]);
  await expect(statement(() => proof())).rejects.toThrow(/new proof|rejected/i);
});
it("removes superseded proof metadata and updates the one latest location", async () => {
  const first = await proof();
  const second = await proof("b".repeat(64));
  expect(
    (await db.query("select id from public.files where bid_id=$1", [bid])).rows,
  ).toEqual([{ id: second }]);
  expect(
    (
      await db.query(
        "select original_file_id from public.bid_application_locations where bid_id=$1",
        [bid],
      )
    ).rows,
  ).toEqual([{ original_file_id: second }]);
  expect(
    (
      await db.query(
        "select id from public.storage_cleanup_tasks where storage_path like $1",
        [`%/${first}`],
      )
    ).rows,
  ).toHaveLength(1);
});
it("authorizes permanent deletion and rejects stale versions without partial removal", async () => {
  await proof();
  await actor(other);
  const targets = JSON.stringify([{ id: bid, version: 1 }]);
  await expect(
    statement(() =>
      db.query("select public.delete_bids($1::jsonb)", [targets]),
    ),
  ).rejects.toThrow(/denied/i);
  await actor(bidder);
  await expect(
    statement(() =>
      db.query("select public.delete_bids($1::jsonb)", [
        JSON.stringify([{ id: bid, version: 0 }]),
      ]),
    ),
  ).rejects.toThrow(/changed/i);
  await db.query("select public.delete_bids($1::jsonb)", [targets]);
  await service();
  expect(
    (await db.query("select id from public.bids where id=$1", [bid])).rows,
  ).toHaveLength(0);
  expect(
    (await db.query("select id from public.files where bid_id=$1", [bid])).rows,
  ).toHaveLength(0);
  expect(
    (await db.query("select id from public.bid_events where bid_id=$1", [bid]))
      .rows,
  ).toHaveLength(0);
});
it("deletes an assignment and its files while preserving the shared profile", async () => {
  await proof();
  await actor();
  await db.query("select public.delete_resume_assignment($1)", [resume]);
  await service();
  expect(
    (await db.query("select id from public.resumes where id=$1", [resume]))
      .rows,
  ).toHaveLength(0);
  expect(
    (
      await db.query("select id from public.candidate_profiles where id=$1", [
        profile,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await db.query(
        "select id from public.files where resume_id=$1 or bid_id=$2",
        [resume, bid],
      )
    ).rows,
  ).toHaveLength(0);
});
it("keeps surviving import IDs aligned with source rows on a lost-response replay after deletion", async () => {
  await actor();
  const rows = JSON.stringify([
    {
      company: "First import",
      role_name: "Engineer",
      url: "https://expiry.test/first",
      source: "Board",
      arrangement: "remote",
      job_status: "open",
    },
    {
      company: "Second import",
      role_name: "Engineer",
      url: "https://expiry.test/second",
      source: "Board",
      arrangement: "remote",
      job_status: "open",
    },
  ]);
  const request = "40000000-0000-4000-8000-000000000099";
  const run = async () =>
    (
      await db.query<{
        result: { ids: string[]; sourceRows: number[]; purgedCount?: number };
      }>(
        "select public.import_bids_reviewed($1,current_date,$2::jsonb,array[10,20],$3) result",
        [resume, rows, request],
      )
    ).rows[0].result;
  const imported = await run();
  const version = (
    await db.query<{ version: number }>(
      "select version from public.bids where id=$1",
      [imported.ids[0]],
    )
  ).rows[0].version;
  await db.query("select public.delete_bids($1::jsonb)", [
    JSON.stringify([{ id: imported.ids[0], version }]),
  ]);
  expect(await run()).toMatchObject({
    ids: [imported.ids[1]],
    sourceRows: [20],
    purgedCount: 1,
  });
});
it("leaves automatic cleanup inactive until rollout activation and blocks old trash after activation", async () => {
  const file = await proof();
  await age(file);
  await db.query("select public.process_screenshot_retention(20)");
  expect(
    (await db.query("select id from public.files where id=$1", [file])).rows,
  ).toHaveLength(1);
  await db.exec("update public.file_retention_settings set enabled=true");
  await actor();
  await expect(
    statement(() => db.query("select public.trash_bid($1,true)", [bid])),
  ).rejects.toThrow(/refresh/i);
});
it("discovers completed operations without files and erases them without needing an active admin", async () => {
  await actor();
  await db.query("select public.delete_bids($1::jsonb)", [
    JSON.stringify([{ id: bid, version: 0 }]),
  ]);
  await service();
  await db.exec("update public.file_retention_settings set enabled=true");
  expect(
    (
      await db.query<{ due: boolean }>(
        "select public.has_due_storage_cleanup() due",
      )
    ).rows[0].due,
  ).toBe(true);
  await db.query("select public.process_legacy_file_cleanup(20)");
  expect(
    (await db.query("select id from public.bid_purge_operations")).rows,
  ).toHaveLength(0);
});
it("bounds legacy cleanup by actual records and processes archived library data with only client accounts", async () => {
  await proof();
  await actor();
  await db.query("select public.archive_candidate_profile($1,true)", [profile]);
  await service();
  await db.exec("update public.file_retention_settings set enabled=true");
  const count = async () =>
    Number(
      (
        await db.query<{ n: number }>(
          "select (select count(*) from public.files)+(select count(*) from public.bids)+(select count(*) from public.resumes)+(select count(*) from public.candidate_profiles) n",
        )
      ).rows[0].n,
    );
  for (let i = 0; i < 8; i++) {
    const before = await count();
    await db.query("select public.process_legacy_file_cleanup(1)");
    expect(before - (await count())).toBeLessThanOrEqual(1);
  }
  expect(
    (
      await db.query("select id from public.candidate_profiles where id=$1", [
        profile,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(
    (await db.query("select id from public.profiles where id=$1", [owner]))
      .rows,
  ).toHaveLength(1);
});
it("scrubs imported IDs when monthly retention deletes applications through its existing path", async () => {
  await actor();
  const row = JSON.stringify([
    {
      company: "Monthly import",
      role_name: "Engineer",
      url: "https://expiry.test/monthly",
      source: "Board",
      arrangement: "remote",
      job_status: "open",
    },
  ]);
  const request = "40000000-0000-4000-8000-000000000098";
  await db.query(
    "select public.import_bids_reviewed($1,current_date,$2::jsonb,array[7],$3)",
    [resume, row, request],
  );
  await service();
  await db.query(
    "update public.bids set applied=true,application_method='manual',rate_cents=125,applied_at='2000-01-01',first_applied_at='2000-01-01' where url='https://expiry.test/monthly'",
  );
  await db.query("select public.process_candidate_retention(20)");
  expect(
    (
      await db.query<{ result: unknown }>(
        "select result from public.bid_import_receipts where request_id=$1",
        [request],
      )
    ).rows[0].result,
  ).toMatchObject({ ids: [], sourceRows: [], purgedCount: 1 });
});
