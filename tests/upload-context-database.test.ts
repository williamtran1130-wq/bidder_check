import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const migration = "supabase/migrations/202610120015_screenshot_upload_context.sql";
const owner = "30000000-0000-4000-8000-000000000001", bidder = "30000000-0000-4000-8000-000000000002", other = "30000000-0000-4000-8000-000000000003", admin = "30000000-0000-4000-8000-000000000004";
let db: PGlite, workspace: string, resume: string, profile: string, bid: string;
const context = { ip: "203.0.113.10", city: "Chicago", region: "IL", country: "US", source: "vercel", status: "available" };
async function asUser(actor = owner) {
  await db.exec("reset role; set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)", [actor]);
}
async function service() { await db.exec("reset role; set role service_role; select set_config('request.jwt.claim.role','service_role',false)"); }
async function prepare(actor = bidder, target = bid) {
  await asUser(actor);
  return (await db.query<{ id: string }>("select public.prepare_file('screenshot',$1,'proof.png','image/png',100) id", [target])).rows[0].id;
}
async function finalize(file: string, actor = bidder, metadata: unknown = context, hash = "a".repeat(64)) {
  await service();
  if (existsSync(migration)) await db.query("select public.finalize_verified_file_v2($1,$2,$3,$4::jsonb)", [file, hash, actor, JSON.stringify(metadata)]);
  else await db.query("select public.finalize_verified_file($1,$2,$3)", [file, hash, actor]);
}
async function history(target = bid) {
  if (!existsSync(migration)) return { items: [], nextCursor: null };
  return (await db.query<{ value: { items: Record<string, unknown>[]; nextCursor: null | { uploadedAt: string; id: string } } }>("select public.manager_screenshot_upload_history($1) value", [target])).rows[0].value;
}
async function current(file: string) {
  if (!existsSync(migration)) return null;
  return (await db.query<{ value: Record<string, unknown> | null }>("select public.manager_screenshot_upload_context($1) value", [file])).rows[0].value;
}
// Expected PostgreSQL errors abort a transaction: recover the statement's
// savepoint before inspecting the atomic rollback or testing another caller.
async function statement<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("savepoint expected_statement");
  try { const value = await fn(); await db.exec("release savepoint expected_statement"); return value; }
  catch (error) { await db.exec("rollback to savepoint expected_statement; release savepoint expected_statement"); throw error; }
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
  for (const file of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  await db.query("insert into auth.users(id,email) values($1,'owner@context.test'),($2,'bidder@context.test'),($3,'other@context.test'),($4,'admin@context.test')", [owner, bidder, other, admin]);
  await db.exec("update public.profiles set approval_status='approved'");
  await db.query("update public.profiles set role='bidder',display_name='Uploader' where id=$1", [bidder]);
  await db.query("update public.profiles set role='admin' where id=$1", [admin]);
  workspace = (await db.query<{ id: string }>("select id from public.workspaces where owner_id=$1", [owner])).rows[0].id;
  await db.query("insert into public.bidders(user_id,workspace_id,default_rate_cents) values($1,$2,125)", [bidder, workspace]);
  await asUser();
  profile = (await db.query<{ id: string }>("select public.save_candidate_profile(null,$1,'CTX','Candidate','','','') id", [workspace])).rows[0].id;
  resume = (await db.query<{ id: string }>("select public.save_resume_assignment(null,$1,$2,'candidate@context.test','555-1000',null,null) id", [profile, bidder])).rows[0].id;
  const resumeFile = (await db.query<{ id: string }>("select public.prepare_file('resume',$1,'resume.pdf','application/pdf',100) id", [resume])).rows[0].id;
  await service(); await db.query("select public.finalize_verified_file($1,$2,$3)", [resumeFile, "c".repeat(64), owner]);
}, 60000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("reset role; begin");
  await asUser();
  bid = (await db.query<{ id: string }>("select public.save_bid(null,$1,'Context Company','Engineer','https://context.test/job','Board','remote','open') id", [resume])).rows[0].id;
});
afterEach(async () => { await db.exec("rollback; reset role"); });

it("atomically records authoritative bid identity and the actual uploader with immutable first-success context", async () => {
  const file = await prepare(); await finalize(file); await asUser();
  const first = await current(file);
  expect(first).toMatchObject({ originalFileId: file, bidId: bid, bidderId: bidder, uploaderId: bidder, uploaderRole: "bidder", uploaderName: "Uploader", ip: "203.0.113.10", city: "Chicago", fileAvailable: true });
  await finalize(file, bidder, { ...context, ip: "198.51.100.2" }); await asUser();
  expect(await current(file)).toEqual(first);
  expect((await history()).items).toHaveLength(1);
  await db.exec("reset role");
  await expect(statement(() => db.query("update public.screenshot_upload_contexts set ip='198.51.100.2' where original_file_id=$1", [file]))).rejects.toThrow(/immutable/i);
});
it("serializes simultaneous retry calls and keeps the first successful context", async () => {
  const file = await prepare(); await service();
  if (existsSync(migration)) await Promise.all([
    db.query("select public.finalize_verified_file_v2($1,$2,$3,$4::jsonb)", [file, "a".repeat(64), bidder, JSON.stringify(context)]),
    db.query("select public.finalize_verified_file_v2($1,$2,$3,$4::jsonb)", [file, "a".repeat(64), bidder, JSON.stringify({ ...context, ip: "198.51.100.2" })]),
  ]); else await finalize(file);
  await asUser(); expect((await history()).items).toHaveLength(1); expect(await current(file)).toMatchObject({ ip: "203.0.113.10" });
});
it("attributes manager uploads to the manager and removes the superseded replacement record", async () => {
  const first = await prepare(); await finalize(first);
  const replacement = await prepare(owner); await finalize(replacement, owner, { ...context, ip: "198.51.100.2" }, "b".repeat(64)); await asUser();
  expect(await current(replacement)).toMatchObject({ uploaderId: owner, uploaderRole: "client", bidderId: bidder, ip: "198.51.100.2" });
  expect((await history()).items).toHaveLength(1);
  await expect(statement(() => current(first))).rejects.toThrow(/Access denied|current screenshot/i);
});
it("does not backfill old finalized evidence and distinguishes newly unavailable metadata", async () => {
  const old = await prepare(); await service(); await db.query("select public.finalize_verified_file($1,$2,$3)", [old, "a".repeat(64), bidder]);
  await finalize(old); await asUser(); expect(await current(old)).toBeNull();
  const next = await prepare(); await finalize(next, bidder, { ip: "bad", city: "Forged", source: "vercel", status: "available" }, "b".repeat(64)); await asUser();
  expect(await current(next)).toMatchObject({ ip: null, city: null, source: "unavailable", status: "unavailable" });
});
it("keeps context through trash and file metadata deletion and cascades when the bid is deleted", async () => {
  const file = await prepare(); await finalize(file); await asUser(); await db.query("select public.trash_bid($1,true)", [bid]);
  expect((await history()).items).toHaveLength(1);
  await db.exec("reset role"); await db.query("update public.bids set applied=false,evidence_file_id=null where id=$1", [bid]);
  await db.query("update public.bid_events set file_id=null where file_id=$1", [file]); await db.query("delete from public.files where id=$1", [file]); await asUser();
  expect((await history()).items).toHaveLength(0);
  await db.exec("reset role"); await db.query("delete from public.bid_events where bid_id=$1", [bid]); await db.query("delete from public.bids where id=$1", [bid]);
  expect((await db.query("select id from public.screenshot_upload_contexts where bid_id=$1", [bid])).rows).toEqual([]);
});
it("denies bidder, foreign manager, unapproved or archived manager review and direct write APIs", async () => {
  const file = await prepare(); await finalize(file);
  for (const actor of [bidder, other]) {
    await asUser(actor); await expect(statement(() => history())).rejects.toThrow(/Access denied/); await expect(statement(() => current(file))).rejects.toThrow(/Access denied/);
    await expect(statement(() => db.query("select id from public.screenshot_upload_contexts"))).rejects.toMatchObject({ code: "42501" });
    await expect(statement(() => db.query("select public.finalize_verified_file_v2($1,$2,$3,$4::jsonb)", [file, "a".repeat(64), actor, JSON.stringify(context)]))).rejects.toMatchObject({ code: "42501" });
  }
  await asUser(admin); expect((await history()).items).toHaveLength(1);
  for (const assignment of ["approval_status='pending'", "archived=true"]) {
    await db.exec("reset role"); await db.query(`update public.profiles set ${assignment} where id=$1`, [owner]); await asUser();
    await expect(statement(() => history())).rejects.toThrow(/Access denied/);
    await db.exec("reset role"); await db.query("update public.profiles set archived=false,approval_status='approved' where id=$1", [owner]);
  }
});
it("rolls screenshot attachment back if immutable context insertion fails", async () => {
  const file = await prepare(); await db.exec("reset role");
  if (existsSync(migration)) await db.exec(`create function public.test_context_reject() returns trigger language plpgsql as $$begin raise exception 'context failure'; end$$;
    create trigger test_context_reject before insert on public.screenshot_upload_contexts for each row execute function public.test_context_reject();`);
  await expect(statement(() => finalize(file))).rejects.toThrow(/context failure/);
  await db.exec("reset role");
  expect((await db.query<{ finalized: boolean }>("select finalized from public.files where id=$1", [file])).rows[0].finalized).toBe(false);
  expect((await db.query<{ applied: boolean }>("select applied from public.bids where id=$1", [bid])).rows[0].applied).toBe(false);
});
it("records nothing for unfinished, rejected, invalid-hash or approval-revision-changed uploads", async () => {
  const file = await prepare(); await asUser(); expect((await history()).items).toEqual([]);
  await expect(statement(() => finalize(file, bidder, context, "invalid"))).rejects.toThrow(/Invalid verified upload/);
  await db.exec("reset role"); await db.query("update public.bids set rejected_hashes=array[$2] where id=$1", [bid, "a".repeat(64)]);
  await expect(statement(() => finalize(file))).rejects.toThrow(/previously rejected/);
  await db.exec("reset role"); await db.query("update public.bids set review_revision=review_revision+1,rejected_hashes='{}' where id=$1", [bid]);
  await expect(statement(() => finalize(file))).rejects.toThrow(/approval changed/i);
  await asUser(); expect((await history()).items).toEqual([]);
});
it("denies anonymous reads and unauthenticated service-role claims", async () => {
  const file = await prepare(); await finalize(file);
  await db.exec("reset role; set role anon");
  await expect(statement(() => db.query("select public.manager_screenshot_upload_context($1)", [file]))).rejects.toMatchObject({ code: "42501" });
  await db.exec("reset role; set role service_role; select set_config('request.jwt.claim.role','authenticated',false)");
  await expect(statement(() => db.query("select public.finalize_verified_file_v2($1,$2,$3,$4::jsonb)", [file, "a".repeat(64), bidder, JSON.stringify(context)]))).rejects.toThrow(/Service role required/);
});
it("returns exactly 50 history rows and a stable nonoverlapping cursor when timestamps tie", async () => {
  await db.exec("reset role");
  await db.query(`insert into public.screenshot_upload_contexts(bid_id,workspace_id,bidder_id,original_file_id,uploader_id,uploader_role,uploaded_at,source,status)
    select $1,$2,$3,gen_random_uuid(),$3,'bidder','2026-10-12 12:00:00+00','unavailable','unavailable' from generate_series(1,56)`, [bid, workspace, bidder]);
  await asUser(); const page = await history(); expect(page.items).toHaveLength(50); expect(page.nextCursor).not.toBeNull();
  const next = (await db.query<{ value: { items: { id: string }[]; nextCursor: null } }>("select public.manager_screenshot_upload_history($1,$2,$3) value", [bid, page.nextCursor!.uploadedAt, page.nextCursor!.id])).rows[0].value;
  expect(next.items).toHaveLength(6); expect(next.nextCursor).toBeNull();
  expect(new Set([...page.items, ...next.items].map((row) => row.id)).size).toBe(56);
  await expect(statement(() => db.query("select public.manager_screenshot_upload_history($1,null,$2) value", [bid, page.nextCursor!.id]))).rejects.toThrow(/Invalid history cursor/);
});
it("deletes private context through confirmed bid purge", async () => {
  const file = await prepare(); await finalize(file); await asUser(); await db.query("select public.trash_bid($1,true)", [bid]);
  const version = (await db.query<{ version: number }>("select version from public.bids where id=$1", [bid])).rows[0].version;
  const operation = (await db.query<{ value: { id: string } }>("select public.prepare_bid_purge('selected',$1::jsonb,null) value", [JSON.stringify([{ id: bid, version }])])).rows[0].value;
  await db.query("select public.confirm_bid_purge($1)", [operation.id]); await db.exec("reset role");
  expect((await db.query("select id from public.screenshot_upload_contexts where bid_id=$1", [bid])).rows).toEqual([]);
});
it("deletes private context through retention without copying network values into retained aggregates", async () => {
  const file = await prepare(); await finalize(file); await db.exec("reset role");
  await db.query("update public.bids set applied_at=clock_timestamp()-interval '5 months',first_applied_at=clock_timestamp()-interval '5 months' where id=$1", [bid]);
  await service(); const result = (await db.query<{ value: { deletedApplications: number } }>("select public.process_candidate_retention(10) value")).rows[0].value;
  expect(result.deletedApplications).toBe(1); await db.exec("reset role");
  expect((await db.query("select id from public.screenshot_upload_contexts where bid_id=$1", [bid])).rows).toEqual([]);
  const aggregates = (await db.query<{ value: Record<string, unknown> }>("select to_jsonb(a) value from public.retained_bid_daily_aggregates a where profile_id=$1", [profile])).rows;
  expect(aggregates.length).toBeGreaterThan(0);
  for (const aggregate of aggregates) expect(Object.keys(aggregate.value).some((key) => /ip|city|region|country|context/.test(key))).toBe(false);
});
it("deletes private context through a scoped application-library reset while cutover is active", async () => {
  const file = await prepare(); await finalize(file); await service();
  const inventory = (await db.query<{ value: { fingerprint: string } }>("select public.application_library_inventory(array[$1::uuid]) value", [workspace])).rows[0].value;
  await db.query("select public.set_application_library_cutover(true)");
  await db.query("select public.reset_application_library(array[$1::uuid],$2,$3)", [workspace, inventory.fingerprint, admin]);
  await db.exec("reset role"); expect((await db.query("select id from public.screenshot_upload_contexts where workspace_id=$1", [workspace])).rows).toEqual([]);
});
it("does not treat PostgreSQL shortened IPv4 notation as a validated request IP", async () => {
  for (const ip of ["127.1", "123", "001.002.003.004"]) {
    const file = await prepare(); await finalize(file, bidder, { ...context, ip }); await asUser();
    expect(await current(file)).toMatchObject({ ip: null, city: null, source: "unavailable", status: "unavailable" });
  }
});
