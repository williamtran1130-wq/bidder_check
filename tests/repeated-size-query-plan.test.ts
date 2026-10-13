import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";

const owner = "00000000-0000-4000-8000-000000000001";
const bidder = "00000000-0000-4000-8000-000000000002";
const pageSize = 25;
const count = 2000;
let db: PGlite;

type PlanNode = {
  "Node Type": string;
  "CTE Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Join Filter"?: number;
  Plans?: PlanNode[];
};

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
  for (const file of readdirSync("supabase/migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  await db.query(
    "insert into auth.users(id,email) values($1,'owner@query-plan.test'),($2,'bidder@query-plan.test')",
    [owner, bidder],
  );
  await db.exec("update public.profiles set approval_status='approved'");
  await db.query("update public.profiles set role='bidder' where id=$1", [
    bidder,
  ]);
  const workspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [owner],
    )
  ).rows[0].id;
  await db.query(
    "insert into public.bidders(user_id,workspace_id,default_rate_cents) values($1,$2,100)",
    [bidder, workspace],
  );
  const profile = (
    await db.query<{ id: string }>(
      "insert into public.candidate_profiles(workspace_id,identifier,candidate_name) values($1,'Plan profile','Synthetic') returning id",
      [workspace],
    )
  ).rows[0].id;
  const resume = (
    await db.query<{ id: string }>(
      "insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name) values($1,$2,$3,'Plan profile','Synthetic') returning id",
      [workspace, bidder, profile],
    )
  ).rows[0].id;
  await db.query(
    `insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,source,arrangement,found_at,review_status,review_revision)
    select $1,$2,$3,'Plan '||n,'Engineer','https://query-plan.test/'||n,'https://query-plan.test/'||n,'synthetic','remote','2026-10-10 12:00Z'::timestamptz-n*interval '1 minute','approved',1
    from generate_series(1,$4::integer) n`,
    [workspace, bidder, resume, count],
  );
  await db.query(
    `insert into public.files(workspace_id,bidder_id,kind,bid_id,filename,mime,size_bytes,storage_path,created_by,finalized,sha256,review_revision)
    select workspace_id,bidder_id,'screenshot',id,'synthetic.png','image/png',
      case when split_part(company,' ',2)::integer<=2 then 100005 else 10240+split_part(company,' ',2)::integer%2 end,
      id::text,$1,true,$2,review_revision from public.bids`,
    [owner, "a".repeat(64)],
  );
  await db.exec(`update public.bids b set evidence_file_id=f.id from public.files f where f.bid_id=b.id;
    update public.bids set applied=split_part(company,' ',2)::integer%4 in (0,1),
      application_method=case when split_part(company,' ',2)::integer%4 in (0,1) then 'screenshot' end,
      rate_cents=case when split_part(company,' ',2)::integer%4 in (0,1) then 100 end,
      applied_at=case when split_part(company,' ',2)::integer%4 in (0,1) then found_at end,
      review_status=case when split_part(company,' ',2)::integer%4=3 then 'pending' else 'approved' end;
    analyze public.bids; analyze public.files; analyze public.profiles; analyze public.bidders;`);
  await db.exec("set role authenticated");
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",
    [owner],
  );
}, 60000);

afterAll(async () => {
  await db.close();
});

async function listingPlan(desc: boolean) {
  const query = {
    search: "Plan",
    sorting: [{ id: "screenshot_size_bytes", desc }],
    columnFilters: { screenshot: "Repeated sizes only" },
    pageSize,
    pageIndex: 20,
  };
  const body = (
    await db.query<{ body: string }>(
      "select prosrc body from pg_proc where oid='public.list_bids_v2(jsonb)'::regprocedure",
    )
  ).rows[0].body;
  let statement = body.slice(
    body.indexOf("with filtered as materialized"),
    body.indexOf(" into result;"),
  );
  const locals = {
    p_query: "($1::jsonb)",
    page_index: "20",
    page_size: String(pageSize),
    sort_id: "'screenshot_size_bytes'",
    sort_desc: String(desc),
    columns: '\'{"screenshot":"Repeated sizes only"}\'::jsonb',
    bidder_filter: "''",
    resume_filter: "''",
    bidder_matches: "'{}'::uuid[]",
    resume_matches: "'{}'::uuid[]",
    can_view_sizes: "true",
  };
  for (const [name, value] of Object.entries(locals))
    statement = statement.replace(new RegExp(`\\b${name}\\b`, "g"), value);
  const result = (
    await db.query<{
      "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[];
    }>(`explain (analyze, buffers, format json) ${statement}`, [
      JSON.stringify(query),
    ])
  ).rows[0]["QUERY PLAN"][0];
  return { result, query };
}

it.each([false, true])(
  "avoids rescanning all repeated evidence once per eligible size-sort row (descending=%s)",
  async (desc) => {
    const { result, query } = await listingPlan(desc);
    const scans: PlanNode[] = [];
    function visit(node: PlanNode) {
      if (node["CTE Name"] === "current_evidence_sizes") scans.push(node);
      node.Plans?.forEach(visit);
    }
    visit(result.Plan);
    const largestScanLoops = Math.max(
      ...scans.map((node) => node["Actual Loops"]),
    );
    // A post-pagination scan can run for each returned page row. It must not
    // rescan the complete materialized evidence for every eligible result row.
    expect(largestScanLoops).toBeLessThanOrEqual(pageSize);
    const value = (
      await db.query<{
        value: {
          total: number;
          statusCounts: Record<string, number>;
          rows: {
            screenshot_size_bytes: number;
            screenshot_size_match_count: number;
          }[];
        };
      }>("select public.list_bids_v2($1::jsonb) value", [JSON.stringify(query)])
    ).rows[0].value;
    expect(value.total).toBe(2000);
    expect(value.statusCounts).toEqual({
      all: 2000,
      applied: 999,
      unapplied: 999,
      pending_review: 500,
    });
    expect(value.rows).toHaveLength(pageSize);
    expect(
      value.rows.every((row) => row.screenshot_size_match_count === 999),
    ).toBe(true);
  },
  60000,
);
