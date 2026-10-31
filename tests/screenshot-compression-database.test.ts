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

type Attempt = { attempt_id: string; storage_path: string };
const sha = "a".repeat(64), storedSha = "b".repeat(64);
async function pending() {
  await actor();
  const id = (await db.query<{ id: string }>("select public.prepare_file('screenshot',$1,'proof.png','image/png',100) id", [bid])).rows[0].id;
  await service();
  return id;
}
async function reserve(id: string, uploader = owner) {
  return (await db.query<{ result: Attempt }>("select public.reserve_screenshot_optimization($1,$2) result", [id,uploader])).rows[0].result;
}
async function finalize(id: string, attempt: Attempt, hash=sha, size=50, uploader=owner) {
  return db.query("select public.finalize_optimized_screenshot($1,$2,$3,'{}',$4,$5,$6)", [id,uploader,hash,attempt.attempt_id,size,storedSha]);
}
async function file(id: string) {
  return (await db.query<Record<string,unknown>>("select * from public.files where id=$1", [id])).rows[0];
}
async function task(path: string) {
  return (await db.query<{id:string;attempts:number;due:number;lease_id:string;first_removed_at:string|null}>("select *,extract(epoch from(next_attempt_at-clock_timestamp()))::float8 due from public.storage_cleanup_tasks where storage_path=$1", [path])).rows[0];
}

it("reserves distinct durable candidates due in ten minutes, hidden from client storage access", async () => {
  const id=await pending(), a=await reserve(id), b=await reserve(id);
  expect(a.storage_path).not.toBe(b.storage_path);
  expect(a.storage_path.startsWith(`${workspace}/${bidder}/`)).toBe(true);
  expect((await task(a.storage_path)).due).toBeGreaterThan(590);
  expect((await task(a.storage_path)).due).toBeLessThanOrEqual(600);
  await db.query("insert into storage.objects(bucket_id,name) values('private-files',$1)",[a.storage_path]);
  await actor();
  expect((await db.query("select name from storage.objects where name=$1",[a.storage_path])).rows).toEqual([]);
  await expect(statement(()=>db.query("insert into storage.objects(bucket_id,name) values('private-files',$1)",[b.storage_path]))).rejects.toThrow(/row.level security/i);
  await expect(statement(()=>reserve(id))).rejects.toThrow(/permission denied/i);
  await expect(statement(()=>finalize(id,a))).rejects.toThrow(/permission denied/i);
});

it("atomically retains WebP while preserving proof metadata, original hash, context and cleanup", async () => {
  const id=await pending(), original=await file(id), a=await reserve(id);
  await finalize(id,a);
  expect(await file(id)).toMatchObject({filename:'proof.png',mime:'image/png',size_bytes:100,sha256:sha,finalized:true,storage_path:a.storage_path,stored_size_bytes:50,stored_mime:'image/webp',stored_sha256:storedSha});
  expect(await task(a.storage_path)).toBeUndefined();
  expect((await task(original.storage_path as string)).due).toBeLessThanOrEqual(0);
  expect((await db.query("select original_file_id from public.bid_application_locations where original_file_id=$1",[id])).rows).toHaveLength(1);
  expect((await db.query("select screenshot_sha256,evidence_file_id from public.bids where id=$1",[bid])).rows[0]).toEqual({screenshot_sha256:sha,evidence_file_id:id});
  await db.query("insert into storage.objects(bucket_id,name) values('private-files',$1)",[a.storage_path]);
  await actor();
  expect((await db.query("select name from storage.objects where name=$1",[a.storage_path])).rows).toEqual([]);
});

it("makes retries immutable and lets only one attempt win while preserving losing cleanup", async () => {
  const id=await pending(), a=await reserve(id), b=await reserve(id);
  await finalize(id,a);
  const before=await file(id);
  await finalize(id,a);
  await finalize(id,b);
  expect(await file(id)).toEqual(before);
  expect(await task(b.storage_path)).toBeDefined();
  await expect(statement(()=>finalize(id,a,'c'.repeat(64)))).rejects.toThrow(/immutable/i);
});

it("returns a server-only committed receipt when finalization wins before reservation", async () => {
  const id=await pending(), a=await reserve(id);
  await finalize(id,a);
  expect(await reserve(id)).toEqual({finalized:true,sha256:sha,stored_size_bytes:50});
});

it.each(["attempts=1", "lease_id=gen_random_uuid()", "lease_until=clock_timestamp()-interval '1 minute'", "first_removed_at=clock_timestamp()", "completed_at=clock_timestamp()"])("rejects cleanup that has ever been claimed: %s", async (change) => {
  const id=await pending(), a=await reserve(id);
  await db.query(`update public.storage_cleanup_tasks set ${change} where storage_path=$1`,[a.storage_path]);
  await expect(statement(()=>finalize(id,a))).rejects.toThrow(/cleanup|expired|unavailable/i);
  expect((await file(id)).finalized).toBe(false);
});

it.each([0,100,101])("rejects retained size %i without finalization or partial state", async size => {
  const id=await pending(), a=await reserve(id), before=await file(id);
  await expect(statement(()=>finalize(id,a,sha,size))).rejects.toThrow(/size|smaller|invalid/i);
  expect(await file(id)).toEqual(before);
  expect(await task(a.storage_path)).toBeDefined();
});

it("rejects another uploader, revoked access, stale approval and rejected original hashes atomically", async () => {
  const id=await pending(), a=await reserve(id);
  await expect(statement(()=>finalize(id,a,sha,50,bidder))).rejects.toThrow(/denied/i);
  await expect(statement(()=>reserve(id,bidder))).rejects.toThrow(/denied/i);
  await db.query("update public.profiles set archived=true where id=$1",[owner]);
  await expect(statement(()=>finalize(id,a))).rejects.toThrow(/denied/i);
  await db.query("update public.profiles set archived=false where id=$1",[owner]);
  await db.query("update public.bids set review_revision=review_revision+1 where id=$1",[bid]);
  await expect(statement(()=>finalize(id,a))).rejects.toThrow(/approval/i);
  await db.query("update public.bids set review_revision=review_revision-1,rejected_hashes=array[$2] where id=$1",[bid,sha]);
  await expect(statement(()=>finalize(id,a))).rejects.toThrow(/rejected|new proof/i);
  expect((await file(id)).finalized).toBe(false);
  expect(await task(a.storage_path)).toBeDefined();
  expect((await db.query("select bid_id from public.bid_application_locations where original_file_id=$1",[id])).rows).toEqual([]);
});

it("expires reservations, rejects abandoned uploads and keeps their candidate cleanup durable", async () => {
  const id=await pending(), a=await reserve(id);
  await db.query("update public.storage_cleanup_tasks set next_attempt_at=clock_timestamp()-interval '1 second' where storage_path=$1",[a.storage_path]);
  await expect(statement(()=>finalize(id,a))).rejects.toThrow(/expired|cleanup|unavailable/i);
  await db.query("update public.files set created_at=clock_timestamp()-interval '25 hours' where id=$1",[id]);
  await expect(statement(()=>reserve(id))).rejects.toThrow(/expired|unavailable/i);
  await db.exec("update public.file_retention_settings set enabled=true");
  await db.query("select public.process_screenshot_retention(20)");
  expect(await file(id)).toBeUndefined();
  expect(await task(a.storage_path)).toBeDefined();
});

it("queues all candidates on permanent deletion and retains the five minute second pass", async () => {
  const id=await pending(), a=await reserve(id), b=await reserve(id);
  await actor();
  const version=(await db.query<{version:number}>("select version from public.bids where id=$1",[bid])).rows[0].version;
  await db.query("select public.delete_bids($1::jsonb)",[JSON.stringify([{id:bid,version}])]);
  await service();
  expect((await task(a.storage_path)).due).toBeLessThanOrEqual(0);
  expect((await task(b.storage_path)).due).toBeLessThanOrEqual(0);
  await expect(statement(()=>finalize(id,a))).rejects.toThrow(/denied|unavailable/i);
  const candidateTask=await task(a.storage_path);
  const claimed=(await db.query<{id:string;lease_id:string}>("select * from public.claim_storage_cleanup(null,100)")).rows.find(x=>x.id===candidateTask.id);
  expect(claimed).toBeDefined();
  await db.query("select public.finish_storage_cleanup($1,$2,true)",[claimed!.id,claimed!.lease_id]);
  expect((await db.query<{due:number;first_removed_at:Date}>("select extract(epoch from(next_attempt_at-clock_timestamp()))::float8 due,first_removed_at from public.storage_cleanup_tasks where id=$1",[claimed!.id])).rows[0]).toMatchObject({first_removed_at:expect.any(Date),due:expect.any(Number)});
  const remaining=(await db.query<{due:number}>("select extract(epoch from(next_attempt_at-clock_timestamp()))::float8 due from public.storage_cleanup_tasks where id=$1",[claimed!.id])).rows[0].due;
  expect(remaining).toBeGreaterThan(290);
});

it("preserves a candidate's five-minute verification delay when its parent is deleted", async () => {
  const id=await pending(), a=await reserve(id);
  await db.query("update public.storage_cleanup_tasks set first_removed_at=clock_timestamp(),next_attempt_at=clock_timestamp()+interval '5 minutes' where storage_path=$1",[a.storage_path]);
  await actor();
  const version=(await db.query<{version:number}>("select version from public.bids where id=$1",[bid])).rows[0].version;
  await db.query("select public.delete_bids($1::jsonb)",[JSON.stringify([{id:bid,version}])]);
  await service();
  expect((await task(a.storage_path)).due).toBeGreaterThan(290);
});

it("rolls back activation, context and original cleanup together if the surrounding transaction fails", async () => {
  const id=await pending(), a=await reserve(id), before=await file(id);
  await db.exec("savepoint activation");
  await finalize(id,a);
  await db.exec("rollback to savepoint activation; release savepoint activation");
  expect(await file(id)).toEqual(before);
  expect(await task(a.storage_path)).toBeDefined();
  expect(await task(before.storage_path as string)).toBeUndefined();
  expect((await db.query("select bid_id from public.bid_application_locations where original_file_id=$1",[id])).rows).toEqual([]);
  await finalize(id,a);
  expect((await file(id)).stored_size_bytes).toBe(50);
});

it("cleans the retained artifact and unused candidates on replacement and expiry", async () => {
  const first=await pending(), a=await reserve(first), unused=await reserve(first);
  await finalize(first,a);
  const second=await pending(), next=await reserve(second);
  await finalize(second,next,'c'.repeat(64));
  expect(await file(first)).toBeUndefined();
  expect((await task(a.storage_path)).due).toBeLessThanOrEqual(0);
  expect((await task(unused.storage_path)).due).toBeLessThanOrEqual(0);
  await age(second);
  await expect(statement(()=>finalize(second,next,'c'.repeat(64)))).rejects.toThrow(/expired/i);
  await db.exec("update public.file_retention_settings set enabled=true");
  await db.query("select public.process_screenshot_retention(20)");
  expect(await file(second)).toBeUndefined();
  expect(await task(next.storage_path)).toBeDefined();
});

it("rejects missing cleanup tasks and cross-file reservation tokens", async () => {
  const first=await pending(), a=await reserve(first), second=await pending();
  await expect(statement(()=>finalize(second,a))).rejects.toThrow(/unavailable/i);
  await db.query("delete from public.storage_cleanup_tasks where storage_path=$1",[a.storage_path]);
  await expect(statement(()=>finalize(first,a))).rejects.toThrow(/cleanup/i);
});

it("enforces representation tuple validity and service-only grants for anonymous callers", async () => {
  const id=await pending(), a=await reserve(id);
  await expect(statement(()=>db.query("update public.files set stored_size_bytes=50 where id=$1",[id]))).rejects.toThrow(/check constraint/i);
  await expect(statement(()=>db.query("update public.files set stored_size_bytes=50,stored_mime='image/webp',stored_sha256=$2 where id=$1",[id,storedSha]))).rejects.toThrow(/check constraint/i);
  await db.exec("reset role; set role anon");
  await expect(statement(()=>reserve(id))).rejects.toThrow(/permission denied/i);
  await expect(statement(()=>finalize(id,a))).rejects.toThrow(/permission denied/i);
});

it.each(["storage_path='tampered'", "stored_size_bytes=40", "stored_sha256=repeat('c',64)", "size_bytes=99", "mime='image/jpeg'", "filename='changed.png'", "sha256=repeat('d',64)"])("protects finalized optimized and legacy proof representations: %s", async change => {
  const id=await pending(), a=await reserve(id);
  await finalize(id,a);
  await expect(statement(()=>db.query(`update public.files set ${change} where id=$1`,[id]))).rejects.toThrow(/immutable/i);
  const legacy=await proof('e'.repeat(64));
  await expect(statement(()=>db.query(`update public.files set ${change} where id=$1`,[legacy]))).rejects.toThrow(/immutable/i);
});
