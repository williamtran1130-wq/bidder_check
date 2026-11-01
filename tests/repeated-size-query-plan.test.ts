import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";

const owner = "00000000-0000-4000-8000-000000000001";
const bidder = "00000000-0000-4000-8000-000000000002";
const pageSize = 25;
const count = 2000;
let db: PGlite;
let fixture: {
  id: string;
  n: number;
  found: number;
  size: number | null;
  applied: boolean;
  pending: boolean;
}[];

type PlanNode = {
  "Node Type": string;
  "CTE Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Join Filter"?: number;
  "Plan Rows": number;
  "Subplan Name"?: string;
  "Relation Name"?: string;
  Alias?: string;
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
  // This read-projection fixture intentionally creates corrupt/unverified pointers as the database owner.
  await db.exec("alter table public.bids disable trigger snapshot_screenshot; alter table public.bids disable trigger cleanup_replaced_screenshot; alter table public.files disable trigger stamp_verified_file");
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
    select $1,$2,$3,'Plan '||n,'Engineer','https://query-plan.test/'||n,'https://query-plan.test/'||n,'synthetic','remote',case when n%4=0 then '2010-01-01 18:00Z'::timestamptz else '2026-10-10 12:00Z'::timestamptz-n*interval '1 minute' end,'approved',1
    from generate_series(1,$4::integer) n`,
    [workspace, bidder, resume, count],
  );
  await db.query(
    `insert into public.files(workspace_id,bidder_id,kind,bid_id,filename,mime,size_bytes,storage_path,created_by,finalized,sha256,review_revision)
    select workspace_id,bidder_id,'screenshot',id,'synthetic.png','image/png',
      case when split_part(company,' ',2)::integer=2000 then 1 when split_part(company,' ',2)::integer<=2 then 100005 else 10240+split_part(company,' ',2)::integer%2 end,
      id::text,$1,true,$2,review_revision from public.bids`,
    [owner, "a".repeat(64)],
  );
  await db.exec(`update public.bids b set evidence_file_id=f.id from public.files f where f.bid_id=b.id;
    update public.bids set applied=split_part(company,' ',2)::integer%4 in (0,1),
      application_method=case when split_part(company,' ',2)::integer%4 in (0,1) then 'screenshot' end,
      rate_cents=case when split_part(company,' ',2)::integer%4 in (0,1) then 100 end,
      applied_at=case when split_part(company,' ',2)::integer%4 in (0,1) then found_at end,
      review_status=case when split_part(company,' ',2)::integer%4=3 then 'pending' else 'approved' end;
    update public.bids set evidence_file_id=null,application_method='manual' where company='Plan 1997';
    update public.files set finalized=false where bid_id=(select id from public.bids where company='Plan 1998');
    update public.files set bid_id=(select id from public.bids where company='Plan 1996') where bid_id=(select id from public.bids where company='Plan 1999');
    analyze public.bids; analyze public.files; analyze public.profiles; analyze public.bidders;`);
  fixture = (
    await db.query<{ id: string; company: string }>(
      "select id,company from public.bids",
    )
  ).rows.map((row) => {
    const n = Number(row.company.split(" ")[1]);
    return {
      id: row.id,
      n,
      found:
        n % 4 === 0
          ? Date.parse("2010-01-01T18:00Z")
          : Date.parse("2026-10-10T12:00Z") - n * 60000,
      size:
        n >= 1997 && n <= 1999
          ? null
          : n === 2000
            ? 1
            : n <= 2
              ? 100005
              : 10240 + (n % 2),
      applied: n % 4 === 0 || n % 4 === 1,
      pending: n % 4 === 3,
    };
  });
  await db.exec("set role authenticated");
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",
    [owner],
  );
}, 60000);

afterAll(async () => {
  await db.close();
});

async function listingPlan(
  desc: boolean,
  repeated = true,
  recent = false,
  pageIndex = 20,
  canViewSizes = true,
) {
  const query = {
    search: "Plan",
    sorting: [{ id: "screenshot_size_bytes", desc }],
    columnFilters: { screenshot: repeated ? "Repeated sizes only" : "" },
    ...(recent
      ? {
          rangeFrom: "2026-09-13T05:00:00.000Z",
          rangeTo: "2026-10-13T05:00:00.000Z",
        }
      : {}),
    pageSize,
    pageIndex,
  };
  const body = (
    await db.query<{ body: string }>(
      "select prosrc body from pg_proc where oid='public.list_bids_v2(jsonb)'::regprocedure",
    )
  ).rows[0].body;
  // Every query in this helper has a literal text search, so the final RPC
  // selects its retained grouped branch even when private size modes are
  // downgraded for a bidder. Explain that branch, not the ordinary-page SELECT.
  // The dedicated list-performance test explains a pending-review query that
  // actually selects the ordinary branch and compares both complete outputs.
  const statementStart = [
    ...body.matchAll(/with (?:application_locations|filtered) as (?:not )?materialized/g),
  ].slice(-1)[0]?.index;
  if (statementStart === undefined)
    throw new Error("Retained list SELECT missing");
  let statement = body.slice(
    statementStart,
    body.indexOf(" into result;", statementStart),
  );
  const locals = {
    p_query: "($1::jsonb)",
    page_index: String(pageIndex),
    page_size: String(pageSize),
    sort_id: canViewSizes ? "'screenshot_size_bytes'" : "'found_at'",
    sort_desc: String(desc),
    columns: `'${JSON.stringify(canViewSizes ? query.columnFilters : { screenshot: "" })}'::jsonb`,
    bidder_filter: "''",
    resume_filter: "''",
    bidder_matches: "'{}'::uuid[]",
    resume_matches: "'{}'::uuid[]",
    can_view_sizes: String(canViewSizes),
    include_older_unapplied: "false",
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
    expect(value.total).toBe(1996);
    expect(value.statusCounts).toEqual({
      all: 1996,
      applied: 997,
      unapplied: 997,
      pending_review: 499,
    });
    expect(value.rows).toHaveLength(pageSize);
    expect(
      value.rows.every((row) => row.screenshot_size_match_count === 997),
    ).toBe(true);
  },
  60000,
);

// Derive expected membership from the known synthetic inputs, independently of
// SQL joins/windows. Includes tiny unique bytes, invalid/missing evidence, date/tie ordering.
function expectedRows(repeated: boolean, recent: boolean, desc: boolean) {
  const base = fixture.filter((row) => !recent || row.n % 4 !== 0);
  const counts = (rows: typeof fixture) => {
    const sizes = new Map<number, number>();
    for (const row of rows)
      if (row.size !== null)
        sizes.set(row.size, (sizes.get(row.size) ?? 0) + 1);
    return sizes;
  };
  const sizes = counts(base);
  const eligible = (rows: typeof fixture) => {
    const groups = counts(rows);
    return repeated
      ? rows.filter((row) => row.size !== null && groups.get(row.size)! >= 2)
      : rows;
  };
  const rows = eligible(base).sort((a, b) => {
    const sizeOrder =
      a.size === null
        ? b.size === null
          ? 0
          : 1
        : b.size === null
          ? -1
          : (a.size - b.size) * (desc ? -1 : 1);
    return sizeOrder || b.found - a.found || a.id.localeCompare(b.id);
  });
  return {
    rows,
    sizes,
    statusCounts: {
      all: rows.length,
      applied: eligible(base.filter((row) => row.applied)).length,
      unapplied: eligible(base.filter((row) => !row.applied)).length,
      pending_review: eligible(base.filter((row) => row.pending)).length,
    },
  };
}

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "keeps snapshot scans linear and returns every benchmark page (repeated=%s, descending=%s)",
  async (repeated, desc) => {
    for (const recent of [false, true]) {
      const expected = expectedRows(repeated, recent, desc);
      const last = Math.ceil(expected.rows.length / pageSize) - 1;
      for (const pageIndex of [0, 1, Math.floor(last / 2), last - 1, last]) {
        const { result, query } = await listingPlan(
          desc,
          repeated,
          recent,
          pageIndex,
        );
        const nodes: PlanNode[] = [];
        const visit = (node: PlanNode) => {
          nodes.push(node);
          node.Plans?.forEach(visit);
        };
        visit(result.Plan);
        const base = nodes.find(
          (node) => node["Relation Name"] === "bids" && node.Alias === "b",
        )!;
        const evidence = nodes.find(
          (node) => node["Subplan Name"] === "CTE current_evidence_sizes",
        )!;
        // Unique-PK LEFT JOIN keeps the authorized base's cardinality estimate.
        expect(evidence["Plan Rows"]).toBe(base["Plan Rows"]);
        expect(evidence["Actual Rows"]).toBe(base["Actual Rows"]);
        const scans = nodes.filter(
          (node) =>
            node["CTE Name"] === "current_evidence_sizes" ||
            node["CTE Name"] === "evidence_groups" ||
            node["CTE Name"] === "filtered" ||
            node["Relation Name"] === "files",
        );
        expect(
          Math.max(
            ...scans
              .filter((node) => node["Node Type"] !== "Index Scan")
              .map((node) => node["Actual Loops"]),
          ),
        ).toBe(1);
        const value = (
          await db.query<{
            value: {
              total: number;
              statusCounts: Record<string, number>;
              rows: {
                id: string;
                company: string;
                screenshot_size_bytes: number | null;
                screenshot_size_match_count: number;
              }[];
            };
          }>("select public.list_bids_v2($1::jsonb) value", [
            JSON.stringify(query),
          ])
        ).rows[0].value;
        expect(value.total).toBe(expected.rows.length);
        expect(value.statusCounts).toEqual(expected.statusCounts);
        expect(value.rows.map((row) => row.id)).toEqual(
          expected.rows
            .slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
            .map((row) => row.id),
        );
        for (const row of value.rows) {
          const input = fixture.find((input) => input.id === row.id)!;
          expect(row.screenshot_size_bytes).toBe(input.size);
          expect(row.screenshot_size_match_count).toBe(
            input.size === null ? 0 : expected.sizes.get(input.size),
          );
        }
      }
    }
  },
  60000,
);

it("does no file scan or private metadata window work for an authenticated bidder", async () => {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    bidder,
  ]);
  try {
    const { result, query } = await listingPlan(true, true, true, 0, false);
    const nodes: PlanNode[] = [];
    const visit = (node: PlanNode) => {
      nodes.push(node);
      node.Plans?.forEach(visit);
    };
    visit(result.Plan);
    expect(nodes.some((node) => node["Relation Name"] === "files")).toBe(false);
    expect(
      nodes.filter((node) => node["Node Type"] === "WindowAgg"),
    ).toHaveLength(1); // only pagination row_number
    const value = (
      await db.query<{ value: { rows: Record<string, unknown>[] } }>(
        "select public.list_bids_v2($1::jsonb) value",
        [JSON.stringify(query)],
      )
    ).rows[0].value;
    expect(value.rows).toHaveLength(pageSize);
    expect(
      value.rows.every(
        (row) =>
          !("screenshot_size_bytes" in row) &&
          !("screenshot_size_match_count" in row),
      ),
    ).toBe(true);
  } finally {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      owner,
    ]);
  }
});

it("counts valid byte groups without sorting the full authorized snapshot", async () => {
  for (const repeated of [false, true]) {
    for (const recent of [false, true]) {
      const { result } = await listingPlan(true, repeated, recent, 0);
      const nodes: PlanNode[] = [];
      const visit = (node: PlanNode) => {
        nodes.push(node);
        node.Plans?.forEach(visit);
      };
      visit(result.Plan);
      const snapshot = nodes.find(
        (node) => node["Subplan Name"] === "CTE current_evidence_sizes",
      )!;
      expect(snapshot["Node Type"]).not.toBe("WindowAgg");
      const groups = nodes.find(
        (node) => node["Subplan Name"] === "CTE evidence_groups",
      )!;
      expect(groups["Node Type"]).toBe("Aggregate");
      // Counts are grouped only for real current evidence, never the missing
      // metadata partition. Distinct groups derive from the independent inputs.
      expect(groups["Actual Rows"]).toBe(
        expectedRows(repeated, recent, true).sizes.size,
      );
      expect(groups["Actual Loops"]).toBe(1);
      expect(
        nodes
          .filter((node) => node["CTE Name"] === "evidence_groups")
          .every((node) => node["Actual Loops"] <= 1),
      ).toBe(true);
      expect(
        nodes.filter((node) => node["Node Type"] === "WindowAgg"),
      ).toHaveLength(1); // pagination only
    }
  }
}, 60000);
