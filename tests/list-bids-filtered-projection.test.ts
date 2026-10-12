import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const migration = "supabase/migrations/202610120011_list_bids_filtered_projection.sql";
const actors = {
  owner: "00000000-0000-4000-8000-000000000001",
  admin: "00000000-0000-4000-8000-000000000002",
  bidder: "00000000-0000-4000-8000-000000000003",
  second: "00000000-0000-4000-8000-000000000004",
  outsider: "00000000-0000-4000-8000-000000000005",
  foreign: "00000000-0000-4000-8000-000000000006",
};
const readers = ["owner", "admin", "bidder", "outsider"] as const;
const sorts = ["found_at", "resume_id", "company", "role_name", "url", "bidder_id", "source", "applied", "applied_at", "arrangement", "job_status", "review_status", "interview_scheduled", "screenshot", "screenshot_size_bytes"];
interface Listing { total: number; rows: Record<string, unknown>[] }
interface Plan { [key: string]: unknown; Plans?: Plan[] }
let db: PGlite;
let primaryResume: string;
const baseline009 = readFileSync("supabase/migrations/202610120009_file_read_scope.sql", "utf8");
const baselineFunction = baseline009.slice(baseline009.indexOf("create or replace function"));
const planSetting = readFileSync("supabase/migrations/202610120010_list_bids_custom_plan.sql", "utf8");
async function oldFunction() {
  await db.exec(`reset role; ${baselineFunction}\n${planSetting}`);
}
async function newFunction() {
  await db.exec("reset role");
  if (existsSync(migration)) await db.exec(readFileSync(migration, "utf8"));
}
async function asUser(id: string) {
  await db.exec("reset role; set role authenticated; set plan_cache_mode=force_generic_plan");
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)", [id]);
}
async function read(query: object) {
  return (await db.query<{ value: Listing }>("select public.list_bids_v2($1::jsonb) value", [JSON.stringify(query)])).rows[0].value;
}
function nodes(node: Plan): Plan[] { return [node, ...(node.Plans?.flatMap(nodes) ?? [])]; }
async function listingPlan() {
  const body = (await db.query<{ body: string }>("select prosrc body from pg_proc where oid='public.list_bids_v2(jsonb)'::regprocedure")).rows[0].body;
  const start = body.indexOf("with filtered as materialized"), end = body.indexOf(" into result;", start);
  let statement = body.slice(start, end);
  const locals = { p_query: "($1::jsonb)", page_index: "0", page_size: "7", sort_id: "'found_at'", sort_desc: "true", columns: "'{}'::jsonb", bidder_filter: "''", resume_filter: "''", bidder_matches: "null::uuid[]", resume_matches: "null::uuid[]", can_view_sizes: "true" };
  for (const [name, value] of Object.entries(locals)) statement = statement.replace(new RegExp(`\\b${name}\\b`, "g"), value);
  await db.exec("set plan_cache_mode=force_custom_plan");
  return (await db.query<{ "QUERY PLAN": { Plan: Plan; "Execution Time": number }[] }>(`explain(analyze,buffers,format json) ${statement}`, [JSON.stringify({ search: "Spool", pageSize: 7 })])).rows[0]["QUERY PLAN"][0];
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb); alter table storage.objects enable row level security;
    grant usage on schema auth,storage to authenticated,service_role; grant all on storage.objects to authenticated,service_role;`);
  for (const file of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql") && name < "202610120011").sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  for (const [name, id] of Object.entries(actors)) await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${name}@spool.test`]);
  await db.exec("update public.profiles set approval_status='approved'");
  await db.query("update public.profiles set role='admin' where id=$1", [actors.admin]);
  await db.query("update public.profiles set role='bidder' where id=any($1::uuid[])", [[actors.bidder, actors.second, actors.foreign]]);
  const workspace = (await db.query<{ id: string }>("select id from public.workspaces where owner_id=$1", [actors.owner])).rows[0].id;
  const outside = (await db.query<{ id: string }>("select id from public.workspaces where owner_id=$1", [actors.outsider])).rows[0].id;
  for (const [ws, user, label] of [[workspace, actors.bidder, "Primary"], [workspace, actors.second, "Secondary"], [outside, actors.foreign, "Foreign"]]) {
    await db.query("insert into public.bidders(workspace_id,user_id) values($1,$2)", [ws, user]);
    const profile = (await db.query<{ id: string }>("insert into public.candidate_profiles(workspace_id,identifier,candidate_name) values($1,$2,$2) returning id", [ws, label])).rows[0].id;
    const resume = (await db.query<{ id: string }>("insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name,email) values($1,$2,$3,$4,$4,$5) returning id", [ws, user, profile, label, `${label}@spool.test`])).rows[0].id;
    if (label === "Primary") primaryResume = resume;
    await db.query(`insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,source,arrangement,found_at,applied,applied_at,rate_cents,application_method,job_status,review_status,review_revision,interview_scheduled,deleted_at)
      select $1,$2,$3,'Spool '||$4||' '||n||repeat('x',180),case when n%3=0 then 'Designer' else 'Engineer' end,'https://spool.test/'||$4||'/'||n,'https://spool.test/'||$4||'/'||n,case when n%3=0 then 'agency' else 'direct' end,case when n%2=0 then 'remote' else 'hybrid' end,'2026-10-12 18:00Z'::timestamptz-(n%28)*interval '1 day',n%3=0,case when n%3=0 then '2026-10-10 18:00Z'::timestamptz end,case when n%3=0 then 125 end,case when n%3=0 then 'manual' end,case when n%5=0 then 'closed' else 'open' end,case when n%4=0 then 'pending' else 'approved' end,1,n%7=0,case when n%11=0 then now() end from generate_series(1,240) n`, [ws, user, resume, label]);
  }
  await db.exec("update public.bids set deleted_at=null");
  await db.query(`insert into public.files(workspace_id,bidder_id,kind,bid_id,filename,mime,size_bytes,storage_path,created_by,finalized,review_revision)
    select workspace_id,bidder_id,'screenshot',id,'Spool.png','image/png',2048+substring(company from ' ([0-9]+)x')::integer%7,id::text,$1,substring(company from ' ([0-9]+)x')::integer%5<>0,1 from public.bids where substring(company from ' ([0-9]+)x')::integer%4<>0`, [actors.owner]);
  await db.exec("update public.bids b set evidence_file_id=f.id from public.files f where f.bid_id=b.id; update public.bids set deleted_at=now() where substring(company from ' ([0-9]+)x')::integer%11=0; analyze; set work_mem='64kB'");
}, 60000);
afterAll(async () => { await db.close(); });

it("removes the redundant status spool and reduces wide filtered spill while retaining one evidence window", async () => {
  await oldFunction(); await asUser(actors.owner);
  const before = await listingPlan();
  await newFunction(); await asUser(actors.owner);
  const after = await listingPlan();
  const beforeNodes = nodes(before.Plan), afterNodes = nodes(after.Plan);
  expect(beforeNodes.some(node => node["Subplan Name"] === "CTE status_filtered")).toBe(true);
  expect(afterNodes.filter(node => node["Subplan Name"] === "CTE status_filtered")).toHaveLength(0);
  expect(Number(after.Plan["Temp Written Blocks"])).toBeLessThan(Number(before.Plan["Temp Written Blocks"]));
  const evidence = afterNodes.filter(node => node["Subplan Name"] === "CTE current_evidence_sizes");
  expect(evidence).toHaveLength(1);
  expect(evidence[0]["Node Type"]).toBe("WindowAgg");
  expect(evidence[0]["Actual Loops"]).toBe(1);
  console.info(`filtered spool temp writes ${before.Plan["Temp Written Blocks"]} -> ${after.Plan["Temp Written Blocks"]}, EXPLAIN ${before["Execution Time"]} -> ${after["Execution Time"]}ms`);
});

it("preserves full 010 output for all 15 sorts, both directions, three pages and four reader roles", async () => {
  await oldFunction();
  const cases: { role: typeof readers[number]; query: object; expected: Listing }[] = [];
  for (const role of readers) {
    await asUser(actors[role]);
    const total = (await read({ search: "Spool", pageSize: 7 })).total;
    const last = Math.max(0, Math.ceil(total / 7) - 1);
    for (const id of sorts) for (const desc of [false, true]) for (const pageIndex of [0, Math.floor(last / 2), last]) {
      const query = { search: "Spool", pageSize: 7, pageIndex, sorting: [{ id, desc }] };
      cases.push({ role, query, expected: await read(query) });
    }
  }
  await newFunction();
  for (const entry of cases) { await asUser(actors[entry.role]); expect(await read(entry.query)).toEqual(entry.expected); }
}, 120000);

it("preserves counts, sources, current sizes and rows under status and base-column filter combinations", async () => {
  const filters: object[] = [
    {}, { search: "Primary" }, { source: "agency" }, { arrangement: "hybrid", job: "open" },
    { scopeBidderId: actors.bidder }, { bidder: actors.bidder, resume: primaryResume },
    { rangeFrom: "2026-10-01T00:00:00Z", rangeTo: "2026-10-13T00:00:00Z" },
    { trash: true, columnFilters: { screenshot: "Has screenshot" } },
    { columnFilters: { company: "Primary", role_name: "Engineer", url: "spool.test" } },
    { columnFilters: { source: "direct", arrangement: "remote", job_status: "open", applied: "Unapplied" } },
    { columnFilters: { bidder_id: actors.bidder, resume_id: "Primary" } },
    { columnFilters: { review_status: "approved", interview_scheduled: "Scheduled", screenshot: "Has screenshot" } },
    { columnFilters: { found_at: { from: "2026-10-01", to: "2026-10-12", presence: "has" }, applied_at: { presence: "empty" } } },
    { columnFilters: { applied_at: { from: "2026-10-01", to: "2026-10-12", presence: "has" } } },
  ];
  const cases: { role: typeof readers[number]; query: object; expected: Listing }[] = [];
  await oldFunction();
  for (const role of readers) {
    await asUser(actors[role]);
    for (const status of ["all", "applied", "unapplied", "pending_review"]) for (const filter of filters) {
      const query = { pageSize: 7, sorting: [{ id: "screenshot_size_bytes", desc: false }], status, ...filter };
      cases.push({ role, query, expected: await read(query) });
    }
  }
  await newFunction();
  for (const entry of cases) { await asUser(actors[entry.role]); expect(await read(entry.query)).toEqual(entry.expected); }
}, 120000);

it("preserves scoped custom planning, invoker permissions and ACL through replacement and later migrations", async () => {
  const inspect = async () => (await db.query<{ proconfig: string[]; prosecdef: boolean; provolatile: string; proowner: number; proacl: string[] }>("select proconfig,prosecdef,provolatile,proowner,proacl::text[] from pg_proc where oid='public.list_bids_v2(jsonb)'::regprocedure")).rows[0];
  await oldFunction(); const before = await inspect();
  await newFunction(); expect(await inspect()).toEqual(before);
  await asUser(actors.owner); await read({});
  expect((await db.query<{ plan_cache_mode: string }>("show plan_cache_mode")).rows[0].plan_cache_mode).toBe("force_generic_plan");
  await expect(read({ pageSize: "invalid" })).rejects.toThrow(/invalid input syntax/);
  expect((await db.query<{ plan_cache_mode: string }>("show plan_cache_mode")).rows[0].plan_cache_mode).toBe("force_generic_plan");
  await db.exec("reset role; set role anon");
  await expect(read({})).rejects.toThrow(/permission denied/);
  await db.exec("reset role");
  for (const file of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql") && name > "202610120011_list_bids_filtered_projection.sql").sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  expect((await inspect()).proconfig).toContain("plan_cache_mode=force_custom_plan");
});
