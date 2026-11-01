import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, afterEach, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
interface Report {
  range: { from: string; to: string; bucketUnit: string; bucketSize: number };
  totals: Record<string, number>;
  financial?: { earningsCents: number; earningsCount: number };
  series: {
    from: string;
    to: string;
    found: number;
    foundApplied: number;
    applied: number;
  }[];
  comparisons: { bidders: Comparison[]; profiles: Comparison[] };
  groups: {
    id: string;
    label: string;
    count: number;
    cents: number;
    applied: number;
    interviews: number;
    conversion: number | null;
  }[];
}
interface Comparison {
  id: string;
  label: string;
  found: number;
  foundApplied: number;
  arrangements: Record<
    "remote" | "onsiteHybrid" | "unspecified",
    { found: number; foundApplied: number }
  >;
}
let db: PGlite;
const owner = "00000000-0000-4000-8000-000000000001";
const bidder = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
let w: string, p: string, r: string;
async function asUser(id: string) {
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false); select set_config('request.jwt.claim.role','authenticated',false)`,
  );
}
async function report(
  name: string,
  from: string | null = null,
  to: string | null = null,
  group = "bidder",
) {
  return (
    await db.query<{ report: Report }>(
      `select public.${name}($1::date,$2::date,null,null,null${name === "dashboard_performance_v2" ? "" : ",$3"}) report`,
      name === "dashboard_performance_v2" ? [from, to] : [from, to, group],
    )
  ).rows[0].report;
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
    "insert into auth.users(id,email) values($1,'owner@report.test'),($2,'bidder@report.test'),($3,'other@report.test')",
    [owner, bidder, other],
  );
  await db.exec("update public.profiles set approval_status='approved'");
  w = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [owner],
    )
  ).rows[0].id;
  await db.query(
    "update public.profiles set role='bidder',display_name='Same' where id=$1",
    [bidder],
  );
  await db.query(
    "insert into public.bidders(user_id,workspace_id,default_rate_cents) values($1,$2,100)",
    [bidder, w],
  );
  p = (
    await db.query<{ id: string }>(
      "insert into public.candidate_profiles(workspace_id,identifier,candidate_name) values($1,'Profile','Name') returning id",
      [w],
    )
  ).rows[0].id;
  r = (
    await db.query<{ id: string }>(
      "insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name) values($1,$2,$3,'Profile','Name') returning id",
      [w, bidder, p],
    )
  ).rows[0].id;
  await db.query(
    `insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,found_at,applied,application_method,rate_cents,applied_at,first_applied_at,interview_scheduled) values
 ($1,$2,$3,'A','Engineer','https://a.test','https://a.test','remote','2020-01-01 06:00Z',true,'manual',100,'2024-01-02 06:00Z','2020-01-02 06:00Z',true),
 ($1,$2,$3,'B','Engineer','https://b.test','https://b.test','remote','2024-01-01 05:59Z',false,null,null,null,null,false)`,
    [w, bidder, r],
  );
  await db.query(
    `insert into public.retained_bid_daily_aggregates(workspace_id,bidder_id,profile_id,resume_id,report_day,metric,record_count,earned_cents,tracked_count,interview_count) values
 ($1,$2,$3,$4,'1990-01-01','found',2,0,0,0),($1,$2,$3,$4,'1990-01-02','earning',2,900,1,1),($1,$2,$3,$4,'1990-01-02','applied_activity',2,0,0,0)`,
    [w, bidder, p, r],
  );
  await asUser(owner);
}, 60000);
afterEach(async () => {
  await db.exec("rollback; reset role");
  await asUser(owner);
});
afterAll(async () => {
  await db?.close();
});

it("keeps transactional summaries equivalent to live events through changes and deletes", async () => {
  await db.exec("begin; reset role");
  const reconciliation = async () => (await db.query<{value:number}>("select private.reconcile_bid_report_daily() value")).rows[0].value;
  expect(await reconciliation()).toBe(0);
  await db.query("update public.bids set arrangement='hybrid',applied=false where company='A'");
  expect(await reconciliation()).toBe(0);
  await db.query("update public.bids set applied=true,applied_at=now(),first_applied_at=coalesce(first_applied_at,now()),rate_cents=100,application_method='manual' where company='B'");
  expect(await reconciliation()).toBe(0);
  await db.query("delete from public.bids where company='A'");
  expect(await reconciliation()).toBe(0);
  await asUser(owner);
  const current=await report("dashboard_performance_v2");
  expect(current.totals.found).toBe(3);
});
it("bundles a bounded interview denominator and denies cross-tenant report access", async () => {
  await db.exec("begin");
  const result=await db.query<{value:{report:Report,mail:unknown,collection:{status:string},interviewPeriod:null}}>("select public.workspace_report_bundle('interviews',null,null,null,null,null,null,'profile') value");
  expect(result.rows[0].value.interviewPeriod).toBeNull();
  expect(result.rows[0].value.collection.status).toBe("not_synced");
  expect(result.rows[0].value.report.totals.applied).toBe(0);
  await asUser(other);
  await expect(db.query("select public.workspace_report_bundle('overview',null,null,$1,null,null,null,'profile')",[w])).rejects.toThrow(/Access denied/);
});
it("reads private normalized mail cubes and accepts metadata-only deltas idempotently", async () => {
  await db.exec("begin");
  const now=new Date().toISOString();
  const day=(await db.query<{day:string}>("select (current_timestamp at time zone 'America/Chicago')::date::text as day")).rows[0].day;
  const full={schema_version:2,mode:"full",client_id:owner,revision:1,generated_at:now,timezone:"America/Chicago",removed_mailboxes:[],mailboxes:[{email:"report@example.test",account_label:"Report",collected_at:now,coverage_start:day,rows:[{date:day,category:"interview_invite",handled:false,action_required:true,retryable:false,count:3}]}]};
  const ingest=async (value:unknown)=>(await db.query<{value:Record<string,unknown>}>("select public.ingest_mail_insights($1::jsonb) value",[JSON.stringify(value)])).rows[0].value;
  expect(await ingest(full)).toMatchObject({ok:true,revision:1});
  const delta={...full,revision:2,mode:"delta",base_revision:1,mailboxes:[{email:"report@example.test",account_label:"Updated",collected_at:now,coverage_start:day}]};
  expect(await ingest(delta)).toMatchObject({ok:true,revision:2,unchanged:false});
  expect(await ingest(delta)).toMatchObject({ok:true,revision:2,unchanged:true});
  const data=(await db.query<{value:{mailboxes:{rows:{count:number}[]}[]}}>("select public.mail_insights_report(null,null,null,null,null,null) value")).rows[0].value;
  expect(data.mailboxes[0].rows[0].count).toBe(3);
  expect(await ingest({...delta,revision:3,base_revision:0})).toMatchObject({code:"revision_conflict",last_revision:2});
  await expect(db.query("select * from private.mail_daily")).rejects.toThrow(/permission denied/);
});

it("uses the same mailbox filter for invitations and first-applied denominators", async () => {
  await db.exec("begin; reset role");
  const day = (await db.query<{day:string}>("select (current_timestamp at time zone 'America/Chicago')::date::text as day")).rows[0].day;
  await db.query("update public.resumes set email='selected@example.test' where id=$1", [r]);
  const profile2=(await db.query<{id:string}>("insert into public.candidate_profiles(workspace_id,identifier,candidate_name) values($1,'Second','Second') returning id",[w])).rows[0].id;
  const resume2=(await db.query<{id:string}>("insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name,email) values($1,$2,$3,'Second','Second','other@example.test') returning id",[w,bidder,profile2])).rows[0].id;
  for (const [assignment,company] of [[r,'Selected'],[resume2,'Other']]) await db.query("insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,arrangement,applied,application_method,rate_cents,applied_at,first_applied_at) values($1,$2,$3,$4,'Engineer','https://rate.test/'||$4,'https://rate.test/'||$4,'remote',true,'manual',100,now(),now())",[w,bidder,assignment,company]);
  await asUser(owner);
  const snapshot={schema_version:1,client_id:owner,revision:1,generated_at:new Date().toISOString(),timezone:'America/Chicago',mailboxes:['selected@example.test','other@example.test'].map(email=>({email,account_label:email,collected_at:new Date().toISOString(),coverage_start:day,rows:[{date:day,category:'interview_invite',handled:false,action_required:true,retryable:false,count:2}]}))};
  await db.query("select public.ingest_mail_insights($1::jsonb)",[JSON.stringify(snapshot)]);
  const value=(await db.query<{value:{report:Report;interview:{applications:number;invitations:number;rate:number;groups:Record<string,{rate:number}>};interviewPeriod:{from:string;to:string}}}>("select public.workspace_report_bundle('overview',$1,$1,$2,$3,null,'selected@example.test','bidder') value",[day,w,bidder])).rows[0].value;
  expect(value.interview).toMatchObject({applications:1,invitations:2,rate:200});
  expect(value.interview.groups[bidder].rate).toBe(200);
  expect(value.interviewPeriod).toEqual({from:day,to:day});
  await db.exec("reset role");
  await db.query("update public.resumes set email='' where id=$1",[resume2]);
  await asUser(bidder);
  const scoped=async()=>(await db.query<{value:{interview:{applications:number;invitations:number;rate:number}}}>("select public.workspace_report_bundle('overview',$1,$1,$2,null,null,null,'bidder') value",[day,w])).rows[0].value;
  expect((await scoped()).interview).toMatchObject({applications:1,invitations:2,rate:200});
  await db.exec("reset role");
  await db.query("update public.resumes set email='other@example.test',archived=true where id=$1",[resume2]);
  await asUser(bidder);
  expect((await scoped()).interview).toMatchObject({applications:1,invitations:2,rate:200});
  await asUser(bidder);
  await expect(db.query("select public.workspace_report_bundle('earnings',null,null,null,null,null,null,'bidder')")).rejects.toThrow(/Access denied/);
});

it("intersects collection histories and fails closed for missing coverage", async () => {
  await db.exec("begin; reset role");
  const day=(await db.query<{day:string}>("select (current_timestamp at time zone 'America/Chicago')::date::text as day")).rows[0].day;
  const input={assignments:[{email:'a@example.test'},{email:'a@example.test'},{email:'b@example.test'}],mailboxes:[{email:'a@example.test',collected_at:`${day}T18:00:00Z`,coverage_start:day},{email:'b@example.test',collected_at:`${day}T19:00:00Z`,coverage_start:'2020-01-01'}]};
  const coverage=async(value:unknown)=>(await db.query<{value:Record<string,unknown>}>("select private.mail_report_coverage($1) value",[JSON.stringify(value)])).rows[0].value;
  expect(await coverage(input)).toMatchObject({status:'ready',from:day,to:day});
  expect(await coverage({...input,mailboxes:input.mailboxes.slice(0,1)})).toMatchObject({status:'not_synced',from:null,to:null});
  await db.exec("update private.reporting_rollout set use_summaries=false");
  await asUser(owner);
  expect((await report('dashboard_performance_v2')).totals.found).toBe(4);
});

it("clears legacy mail blobs after cutover without changing normalized counts or receipts", async () => {
  await db.exec("begin; reset role");
  await db.query("insert into public.mail_insights_state(client_id,workspace_id,last_revision,original_hash,mailboxes) values($1,$2,7,'receipt','[{\"email\":\"legacy@example.test\"}]'::jsonb)",[owner,w]);
  await db.query("insert into private.mail_mailboxes values($1,'legacy@example.test','Legacy',now(),(current_timestamp at time zone 'America/Chicago')::date)",[owner]);
  await db.query("insert into private.mail_daily values($1,'legacy@example.test',(current_timestamp at time zone 'America/Chicago')::date,'interview_invite',false,true,false,2)",[owner]);
  const cleanup=readFileSync('supabase/migrations/202610310004_remove_legacy_mail_snapshot_blobs.sql','utf8');
  await db.exec(cleanup);
  await db.exec(cleanup);
  expect((await db.query<{mailboxes:unknown[];last_revision:number;original_hash:string}>("select mailboxes,last_revision,original_hash from public.mail_insights_state where client_id=$1",[owner])).rows[0]).toEqual({mailboxes:[],last_revision:7,original_hash:'receipt'});
  expect((await db.query<{n:number}>("select n::integer from private.mail_daily where client_id=$1",[owner])).rows[0].n).toBe(2);
});
