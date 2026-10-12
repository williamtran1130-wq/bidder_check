import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { performance } from "node:perf_hooks";

const migration = "supabase/migrations/202610120010_list_bids_custom_plan.sql";
const actors = {
  owner: "00000000-0000-4000-8000-000000000001",
  admin: "00000000-0000-4000-8000-000000000002",
  bidder: "00000000-0000-4000-8000-000000000003",
  second: "00000000-0000-4000-8000-000000000004",
  outsider: "00000000-0000-4000-8000-000000000005",
};
const modes = ["auto", "force_generic_plan", "force_custom_plan"];
const sorts = ["found_at", "resume_id", "company", "role_name", "url", "bidder_id", "source", "applied", "applied_at", "arrangement", "job_status", "review_status", "interview_scheduled", "screenshot", "screenshot_size_bytes"];
interface FunctionMetadata {
  body: string;
  definer: boolean;
  volatility: string;
  acl: string[];
  config: string[];
  owner: number;
}
let db: PGlite;
let baseline: FunctionMetadata;
async function metadata() {
  return (await db.query<FunctionMetadata>(`select prosrc body,prosecdef definer,provolatile volatility,proacl::text[] acl,proconfig config,proowner owner from pg_proc where oid='public.list_bids_v2(jsonb)'::regprocedure`)).rows[0];
}
async function asUser(id: string, mode: string) {
  await db.exec(`reset role; set plan_cache_mode=${mode}; set role authenticated`);
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)", [id]);
}
async function read(query: object) {
  return (await db.query<{ value: { total: number; rows: Record<string, unknown>[] } }>("select public.list_bids_v2($1::jsonb) value", [JSON.stringify(query)])).rows[0].value;
}
async function callerMode() {
  return (await db.query<{ plan_cache_mode: string }>("show plan_cache_mode")).rows[0].plan_cache_mode;
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
  for (const file of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql") && name < "202610120010").sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  baseline = await metadata();
  for (const [name, id] of Object.entries(actors)) await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${name}@plan-cache.test`]);
  await db.exec("update public.profiles set approval_status='approved'");
  await db.query("update public.profiles set role='admin' where id=$1", [actors.admin]);
  await db.query("update public.profiles set role='bidder' where id=any($1::uuid[])", [[actors.bidder, actors.second]]);
  const workspace = (await db.query<{ id: string }>("select id from public.workspaces where owner_id=$1", [actors.owner])).rows[0].id;
  const profile = (await db.query<{ id: string }>("insert into public.candidate_profiles(workspace_id,identifier,candidate_name) values($1,'Cache','Cache') returning id", [workspace])).rows[0].id;
  const resumes: string[] = [];
  for (const user of [actors.bidder, actors.second]) {
    await db.query("insert into public.bidders(user_id,workspace_id) values($1,$2)", [user, workspace]);
    resumes.push((await db.query<{ id: string }>("insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name) values($1,$2::uuid,$3,($2::uuid)::text,'Cache') returning id", [workspace, user, profile])).rows[0].id);
  }
  await db.query(`insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,source,arrangement,found_at,applied,applied_at,job_status,review_status,review_revision,interview_scheduled,rate_cents,application_method)
    select $1,case when n%2=0 then $2::uuid else $3::uuid end,case when n%2=0 then $4::uuid else $5::uuid end,'Plan main '||n,case when n%3=0 then 'Designer' else 'Engineer' end,'https://plan.invalid/'||n,'https://plan.invalid/'||n,case when n%3=0 then 'agency' else 'direct' end,case when n%2=0 then 'remote' else 'hybrid' end,'2026-10-12 18:00Z'::timestamptz-(n%28)*interval '1 day',n%3=0,case when n%3=0 then '2026-10-10 18:00Z'::timestamptz end,case when n%5=0 then 'closed' else 'open' end,case when n%4=0 then 'pending' else 'approved' end,1,n%7=0,case when n%3=0 then 125 end,case when n%3=0 then 'manual' end
    from generate_series(0,1399) n`, [workspace, actors.bidder, actors.second, resumes[0], resumes[1]]);
  await db.query(`insert into public.files(workspace_id,bidder_id,kind,bid_id,filename,mime,size_bytes,storage_path,created_by,finalized,review_revision)
    select b.workspace_id,b.bidder_id,'screenshot',b.id,'Plan.png','image/png',2048+substring(b.company from '[0-9]+$')::integer%700,b.id::text,$1,substring(b.company from '[0-9]+$')::integer%8<>0,1 from public.bids b where substring(b.company from '[0-9]+$')::integer%4<>0`, [actors.owner]);
  await db.exec("update public.bids b set evidence_file_id=f.id from public.files f where f.bid_id=b.id; analyze public.bids; analyze public.files");
  if (existsSync(migration)) await db.exec(readFileSync(migration, "utf8"));
}, 60000);
afterAll(async () => { await db.close(); });

it("uses custom plans only within list_bids_v2 and preserves its body and permissions", async () => {
  await db.exec("reset role");
  const after = await metadata();
  expect(after.config).toEqual([...baseline.config, "plan_cache_mode=force_custom_plan"]);
  expect({ ...after, config: baseline.config }).toEqual(baseline);
  expect(after.definer).toBe(false);
  expect(after.volatility).toBe("s");
  expect((await db.query<{ allowed: boolean }>("select has_function_privilege('anon','public.list_bids_v2(jsonb)','execute') allowed")).rows[0].allowed).toBe(false);
  expect((await db.query<{ allowed: boolean }>("select has_function_privilege('authenticated','public.list_bids_v2(jsonb)','execute') allowed")).rows[0].allowed).toBe(true);
});

it("preserves exact 009 outputs for every sort, both directions, pages and reader roles under every caller plan mode", async () => {
  await db.exec("reset role; alter function public.list_bids_v2(jsonb) reset plan_cache_mode");
  const expected = new Map<string, unknown>();
  const roles = ["owner", "admin", "bidder", "outsider"] as const;
  for (const role of roles) {
    await asUser(actors[role], "force_custom_plan");
    for (const sort of sorts) for (const desc of [false, true]) for (const pageIndex of role === "bidder" ? [0, 3, 6] : [0, 7, 13]) {
      const query = { search: "Plan main", pageIndex, pageSize: 100, sorting: [{ id: sort, desc }] };
      expected.set(JSON.stringify([role, sort, desc, pageIndex]), await read(query));
    }
  }
  await db.exec("reset role");
  if (existsSync(migration)) await db.exec(readFileSync(migration, "utf8"));
  for (const mode of modes) for (const role of roles) {
    await asUser(actors[role], mode);
    for (const sort of sorts) for (const desc of [false, true]) for (const pageIndex of role === "bidder" ? [0, 3, 6] : [0, 7, 13]) {
      const query = { search: "Plan main", pageIndex, pageSize: 100, sorting: [{ id: sort, desc }] };
      expect(await read(query)).toEqual(expected.get(JSON.stringify([role, sort, desc, pageIndex])));
      expect(await callerMode()).toBe(mode);
    }
  }
}, 240000);

it("restores the caller plan mode after repeated cold and warm RPCs and errors", async () => {
  for (const mode of modes) for (const role of ["owner", "admin", "bidder"] as const) {
    await db.exec("reset role; discard plans");
    await asUser(actors[role], mode);
    const samples: number[] = [];
    for (let index = 0; index < 7; index++) {
      const start = performance.now();
      const data = await read({ search: "Plan main", pageIndex: index % 3, pageSize: 100, sorting: [{ id: index % 2 ? "screenshot_size_bytes" : "found_at", desc: index % 2 === 0 }] });
      samples.push(Math.round(performance.now() - start));
      expect(data.total).toBe(role === "bidder" ? 700 : 1400);
      expect(data.rows).toHaveLength(100);
      expect(await callerMode()).toBe(mode);
      for (const row of data.rows) expect("screenshot_size_bytes" in row).toBe(role !== "bidder");
    }
    console.info(`plan-cache ${mode} ${role}, cold/warm ms: ${samples.join(",")}`);
    await expect(read({ pageIndex: "invalid" })).rejects.toThrow(/invalid input syntax/);
    expect(await callerMode()).toBe(mode);
  }
}, 60000);

it("retains the scoped custom-plan setting after all later migrations", async () => {
  await db.exec("reset role");
  for (const file of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql") && name > "202610120010_list_bids_custom_plan.sql").sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  expect((await metadata()).config).toContain("plan_cache_mode=force_custom_plan");
});
