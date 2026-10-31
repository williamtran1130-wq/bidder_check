import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { formatInTimeZone } from "date-fns-tz";

let db: PGlite;
const client = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const bidder = "10000000-0000-4000-8000-000000000003";
const colleague = "10000000-0000-4000-8000-000000000004";
const today = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
let workspace: string, assignment: string;
const row = { date: today, category: "application_ack", handled: false, action_required: false, retryable: false, count: 7 };
const snapshot = (revision = 1) => ({ schema_version: 1, client_id: client, revision, generated_at: new Date().toISOString(), timezone: "America/Chicago", mailboxes: [
  {email: "assigned@example.test", account_label: "Assigned", collected_at: null, coverage_start: null, rows: [row]},
  {email: "private@example.test", account_label: "Private", collected_at: null, coverage_start: null, rows: [{...row,count: 13}]},
] });
async function asUser(id: string) {
  await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false); select set_config('request.jwt.claim.role','authenticated',false)`);
}
async function upload(payload: unknown) {
  return (await db.query<{result: Record<string, unknown>}>("select public.ingest_mail_insights($1::jsonb) result", [JSON.stringify(payload)])).rows[0].result;
}
async function report() {
  return (await db.query<{result: {mailboxes: {email: string}[]; assignments: {email: string}[]; bid_rows: {found: number}[];status:string}}>("select public.mail_insights_report($1::date,$1::date,null,null,null,null) result", [today])).rows[0].result;
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
    alter table storage.objects enable row level security;
    grant usage on schema auth,storage to authenticated,service_role;
    grant all on storage.objects to authenticated,service_role;`);
  for (const file of readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`,"utf8"));
  for (const [id,email] of [[client,"client@insights.test"],[other,"other@insights.test"],[bidder,"bidder@insights.test"],[colleague,"colleague@insights.test"]]) {
    await db.query("insert into auth.users(id,email) values($1,$2)",[id,email]);
  }
  await db.exec("update public.profiles set approval_status='approved'");
  workspace=(await db.query<{id:string}>("select id from public.workspaces where owner_id=$1",[client])).rows[0].id;
  await db.query("update public.profiles set role='bidder' where id in ($1,$2)",[bidder,colleague]);
  await db.query("insert into public.bidders(user_id,workspace_id) values($1,$3),($2,$3)",[bidder,colleague,workspace]);
  const profile=(await db.query<{id:string}>("insert into public.candidate_profiles(workspace_id,identifier,candidate_name) values($1,'MAIL-01','Candidate') returning id",[workspace])).rows[0].id;
  for (const [id,email] of [[bidder,"assigned@example.test"],[colleague,"private@example.test"]]) {
    const r=(await db.query<{id:string}>("insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name,email,phone) values($1,$2,$3,'MAIL-01','Candidate',$4,'555-0000') returning id",[workspace,id,profile,email])).rows[0].id;
    if(id===bidder) assignment=r;
  }
  await db.query("insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,source,arrangement,job_status) values($1,$2,$3,'Example','Engineer','https://example.test/job','https://example.test/job','test','remote','open')",[workspace,bidder,assignment]);
},60000);
afterAll(async()=>{await db?.close()});

it("stores a complete snapshot and preserves idempotency after a repeated delivery", async()=>{
  await asUser(client);
  const payload=snapshot();
  const first=await upload(payload);
  expect(first).toMatchObject({ok:true,revision:1,unchanged:false});
  const retry=await upload(payload);
  expect(retry).toMatchObject({ok:true,revision:1,unchanged:true,received_at:first.received_at});
  expect((await report()).mailboxes).toHaveLength(2);
});
it("projects every bidder field before returning and denies raw snapshot reads", async()=>{
  await asUser(bidder);
  const result=await report();
  expect(result.mailboxes.map(m=>m.email)).toEqual(["assigned@example.test"]);
  expect(result.assignments.map(m=>m.email)).toEqual(["assigned@example.test"]);
  expect(result.bid_rows.reduce((n,r)=>n+r.found,0)).toBe(1);
  expect(JSON.stringify(result)).not.toContain("private@example.test");
  await expect(db.query("select * from public.mail_insights_state")).rejects.toThrow(/permission denied/);
});
it("rejects tenant spoofing and bidder uploads and keeps the previous good snapshot",async()=>{
  await asUser(other);
  await expect(upload(snapshot(2))).rejects.toThrow(/Access denied/);
  expect((await report()).status).toBe("not_synced");
  await asUser(bidder);
  await expect(upload({...snapshot(2),client_id:bidder})).rejects.toThrow(/Access denied/);
  await asUser(client);
  expect((await report()).mailboxes).toHaveLength(2);
});
it("rejects old or conflicting revisions, duplicate cubes, and message-content fields",async()=>{
  await asUser(client);
  expect(await upload(snapshot(1))).toMatchObject({code:"revision_conflict",last_revision:1});
  const duplicate=snapshot(2); duplicate.mailboxes[0].rows.push(row);
  await expect(upload(duplicate)).rejects.toThrow(/Invalid snapshot/);
  await expect(upload({...snapshot(2),subject:"must never store this"})).rejects.toThrow(/Invalid snapshot/);
  const extra=snapshot(2); Object.assign(extra.mailboxes[0],{messages:[]});
  await expect(upload(extra)).rejects.toThrow(/Invalid snapshot/);
  expect((await report()).mailboxes).toHaveLength(2);
});
it("revokes mailbox visibility as soon as an assignment is archived",async()=>{
  await db.exec("reset role");
  await db.query("update public.resumes set archived=true where id=$1",[assignment]);
  await asUser(bidder);
  expect((await report()).mailboxes).toHaveLength(0);
  await db.exec("reset role");
  await db.query("update public.resumes set archived=false where id=$1",[assignment]);
});
it("uses read-time retention and preserves ingestion hashes when pruning rows",async()=>{
  await asUser(client);
  const payload=snapshot(2); await upload(payload);
  await db.exec("reset role");
  await db.query("update public.mail_insights_state set mailboxes='[]'::jsonb where client_id=$1",[client]);
  await asUser(client);
  expect(await upload(payload)).toMatchObject({unchanged:true,revision:2});
  expect((await report()).mailboxes).toHaveLength(0);
});
it("filters original bid reporting by current assignment email without widening bidder scope",async()=>{
  await asUser(bidder);
  const read=async(email:string)=>(await db.query<{result:{totals:{found:number};financial?:unknown}}>("select public.dashboard_email_performance($1::date,$1::date,null,null,null,$2) result",[today,email])).rows[0].result;
  expect((await read("assigned@example.test")).totals.found).toBe(1);
  const hidden=await read("private@example.test");
  expect(hidden.totals.found).toBe(0);expect(hidden.financial).toBeUndefined();
});
it("acknowledges an identical expired retry without restoring pruned data or advancing freshness",async()=>{
  const payload=snapshot(3);
  payload.mailboxes[0].rows[0]={...row,date:"2020-01-01"};
  // Simulate the server clock advancing after acceptance: its ledger retains the
  // accepted payload hash while a retention pass has removed all old cube rows.
  await db.exec("reset role");
  await db.query("update public.mail_insights_state set last_revision=3,original_hash=encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex'),mailboxes='[]'::jsonb where client_id=$1",[client,JSON.stringify(payload)]);
  await asUser(client);
  expect(await upload(payload)).toMatchObject({unchanged:true,revision:3});
  expect((await report()).mailboxes).toHaveLength(0);
});
