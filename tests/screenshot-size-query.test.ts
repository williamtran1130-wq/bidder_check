import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

interface Row {
  id: string;
  company: string;
  evidence_file_id: string | null;
  screenshot_size_bytes?: number | null;
  screenshot_size_match_count?: number;
}
interface Listing {
  rows: Row[];
  total: number;
  sources: string[];
  statusCounts: Record<string, number>;
}
interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Subplan Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Actual Total Time": number;
  "Sort Method"?: string;
  Plans?: PlanNode[];
}
const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const admin = "00000000-0000-4000-8000-000000000003";
const bidder = "00000000-0000-4000-8000-000000000004";
const secondBidder = "00000000-0000-4000-8000-000000000005";
const foreignBidder = "00000000-0000-4000-8000-000000000006";
const ids = {
  Small: "00000000-0000-4000-8000-000000000101",
  "Exact A": "00000000-0000-4000-8000-000000000102",
  "Exact B": "00000000-0000-4000-8000-000000000103",
  Rounded: "00000000-0000-4000-8000-000000000104",
  Large: "00000000-0000-4000-8000-000000000105",
  Missing: "00000000-0000-4000-8000-000000000106",
  Foreign: "00000000-0000-4000-8000-000000000107",
};
let db: PGlite;
let workspace: string, foreignWorkspace: string;
let resume: string, secondResume: string, foreignResume: string;

async function asUser(id: string) {
  await db.exec("reset role; set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec(
    "select set_config('request.jwt.claim.role','authenticated',false)",
  );
}
async function list(query: Record<string, unknown> = {}) {
  return (
    await db.query<{ value: Listing }>(
      "select public.list_bids_v2($1::jsonb) value",
      [JSON.stringify(query)],
    )
  ).rows[0].value;
}
async function repeatedList(query: Record<string, unknown> = {}) {
  return list({
    ...query,
    columnFilters: {
      ...(query.columnFilters as Record<string, unknown> | undefined),
      screenshot: "Repeated sizes only",
    },
  });
}
// Explain the deployed function's complete SELECT, with the PL/pgSQL locals
// supplied explicitly. This preserves the actual CTEs, joins and role/RLS.
async function explainListing(canViewSizes: boolean, sort: string) {
  const body = (
    await db.query<{ body: string }>(
      "select prosrc body from pg_proc where oid='public.list_bids_v2(jsonb)'::regprocedure",
    )
  ).rows[0].body;
  let statement = body.slice(
    body.search(/with filtered as (?:not )?materialized/),
    body.indexOf(" into result;"),
  );
  const locals: Record<string, string> = {
    p_query: "($1::jsonb)",
    page_index: "40",
    page_size: "25",
    sort_id: `'${sort}'`,
    sort_desc: "true",
    columns: "'{}'::jsonb",
    bidder_filter: "''",
    resume_filter: "''",
    bidder_matches: "'{}'::uuid[]",
    resume_matches: "'{}'::uuid[]",
    can_view_sizes: String(canViewSizes),
  };
  for (const [variable, value] of Object.entries(locals))
    statement = statement.replace(new RegExp(`\\b${variable}\\b`, "g"), value);
  const result = (
    await db.query<{
      "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[];
    }>(`explain (analyze, buffers, format json) ${statement}`, [
      JSON.stringify({ search: "Batch" }),
    ])
  ).rows[0]["QUERY PLAN"][0];
  const interesting: Record<string, unknown>[] = [];
  function visit(node: PlanNode) {
    if (
      node["Relation Name"] === "files" ||
      node["Subplan Name"]?.includes("current_evidence_sizes") ||
      node["Sort Method"]
    ) {
      interesting.push({
        node: node["Node Type"],
        relation: node["Relation Name"],
        subplan: node["Subplan Name"],
        rows: node["Actual Rows"],
        loops: node["Actual Loops"],
        ms: node["Actual Total Time"],
        sort: node["Sort Method"],
      });
    }
    node.Plans?.forEach(visit);
  }
  visit(result.Plan);
  return { executionMs: result["Execution Time"], nodes: interesting };
}
async function changeCounterpart(sql: string) {
  await db.exec("reset role");
  await db.query(`update public.bids set ${sql} where id=$1`, [ids["Exact B"]]);
  await asUser(owner);
}
function exactA(value: Listing) {
  return value.rows.find((row) => row.id === ids["Exact A"]);
}
async function attach(
  id: string,
  size: number,
  overrides: Record<string, unknown> = {},
) {
  const values = {
    workspace,
    bidder,
    kind: "screenshot",
    bid: id,
    resume: null,
    finalized: true,
    ...overrides,
  };
  const file = (
    await db.query<{ id: string }>(
      `insert into public.files(workspace_id,bidder_id,kind,bid_id,resume_id,filename,mime,size_bytes,storage_path,created_by,finalized,sha256,review_revision)
     values($1,$2,$3,$4,$5,'evidence.png','image/png',$6,gen_random_uuid()::text,$7,$8,$9,(select review_revision from public.bids where id=$4)) returning id`,
      [
        values.workspace,
        values.bidder,
        values.kind,
        values.bid,
        values.resume,
        size,
        owner,
        values.finalized,
        "a".repeat(64),
      ],
    )
  ).rows[0].id;
  await db.query("update public.bids set evidence_file_id=$1 where id=$2", [
    file,
    id,
  ]);
  return file;
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
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
  for (const [id, email] of [
    [owner, "owner"],
    [other, "other"],
    [admin, "admin"],
    [bidder, "first"],
    [secondBidder, "second"],
    [foreignBidder, "foreign"],
  ]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [
      id,
      `${email}@size.test`,
    ]);
  }
  await db.exec("update public.profiles set approval_status='approved'");
  await db.query("update public.profiles set role='admin' where id=$1", [
    admin,
  ]);
  await db.query(
    "update public.profiles set role='bidder',display_name=case when id=$1 then 'First bidder' else 'Second bidder' end where id=any($2::uuid[])",
    [bidder, [bidder, secondBidder, foreignBidder]],
  );
  workspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [owner],
    )
  ).rows[0].id;
  foreignWorkspace = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_id=$1",
      [other],
    )
  ).rows[0].id;
  for (const [user, ws, identifier] of [
    [bidder, workspace, "Main profile"],
    [secondBidder, workspace, "Other profile"],
    [foreignBidder, foreignWorkspace, "Foreign profile"],
  ]) {
    await db.query(
      "insert into public.bidders(user_id,workspace_id,default_rate_cents) values($1,$2,125)",
      [user, ws],
    );
    const profile = (
      await db.query<{ id: string }>(
        "insert into public.candidate_profiles(workspace_id,identifier,candidate_name) values($1,$2,$2) returning id",
        [ws, identifier],
      )
    ).rows[0].id;
    const result = (
      await db.query<{ id: string }>(
        "insert into public.resumes(workspace_id,bidder_id,profile_id,identifier,candidate_name) values($1,$2,$3,$4,$4) returning id",
        [ws, user, profile, identifier],
      )
    ).rows[0].id;
    if (user === bidder) resume = result;
    else if (user === secondBidder) secondResume = result;
    else foreignResume = result;
  }
  const fixtures = [
    { company: "Small", size: 2, found: "2026-10-06" },
    { company: "Exact A", size: 10240, found: "2026-10-05" },
    { company: "Exact B", size: 10240, found: "2026-10-05", second: true },
    { company: "Rounded", size: 10241, found: "2026-10-04" },
    { company: "Large", size: 100000, found: "2026-10-03" },
    { company: "Missing", size: null, found: "2026-10-07" },
    { company: "Foreign", size: 10240, found: "2026-10-08", foreign: true },
  ] as const;
  for (const fixture of fixtures) {
    const ws = "foreign" in fixture ? foreignWorkspace : workspace;
    const user =
      "foreign" in fixture
        ? foreignBidder
        : "second" in fixture
          ? secondBidder
          : bidder;
    const assignment =
      "foreign" in fixture
        ? foreignResume
        : "second" in fixture
          ? secondResume
          : resume;
    await db.query(
      `insert into public.bids(id,workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,source,arrangement,found_at,review_status)
      values($1,$2,$3,$4,$5,'Engineer',$6,$6,'LinkedIn','remote',$7,'approved')`,
      [
        ids[fixture.company],
        ws,
        user,
        assignment,
        fixture.company,
        `https://size.test/${fixture.company.replace(" ", "-")}`,
        `${fixture.found} 12:00Z`,
      ],
    );
    if (fixture.size !== null)
      await attach(ids[fixture.company], fixture.size, {
        workspace: ws,
        bidder: user,
      });
  }
}, 60000);
beforeEach(async () => {
  await db.exec("reset role; begin");
  await asUser(owner);
});
afterEach(async () => {
  await db.exec("rollback; reset role");
});
afterAll(async () => {
  await db.close();
});

it.each([
  [false, ["Small", "Exact A", "Exact B", "Rounded", "Large", "Missing"]],
  [true, ["Large", "Rounded", "Exact A", "Exact B", "Small", "Missing"]],
] as const)(
  "sorts exact numeric sizes before pagination (descending=%s), nulls last and deterministic ties",
  async (desc, expected) => {
    const names: string[] = [];
    for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
      const value = await list({
        sorting: [{ id: "screenshot_size_bytes", desc }],
        pageSize: 2,
        pageIndex,
      });
      expect(value.total).toBe(6);
      names.push(...value.rows.map((row) => row.company));
    }
    expect(names).toEqual(expected);
  },
);

it("counts exact bytes across ordinary-sort pages without merging rounded-equal sizes", async () => {
  const first = await list({
    sorting: [{ id: "company", desc: false }],
    pageSize: 1,
  });
  const second = await list({
    sorting: [{ id: "company", desc: false }],
    pageSize: 1,
    pageIndex: 1,
  });
  expect(first.rows[0]).toMatchObject({
    company: "Exact A",
    screenshot_size_bytes: 10240,
    screenshot_size_match_count: 2,
  });
  expect(second.rows[0]).toMatchObject({
    company: "Exact B",
    screenshot_size_bytes: 10240,
    screenshot_size_match_count: 2,
  });
  expect(
    (await list()).rows.find((row) => row.company === "Rounded"),
  ).toMatchObject({
    screenshot_size_bytes: 10241,
    screenshot_size_match_count: 1,
  });
  expect(
    (await list()).rows.find((row) => row.company === "Missing"),
  ).toMatchObject({
    screenshot_size_bytes: null,
    screenshot_size_match_count: 0,
  });
});

it("filters repeated exact sizes before sorting and pagination across the full snapshot", async () => {
  const rows: Row[] = [];
  for (const pageIndex of [0, 1]) {
    const value = await repeatedList({
      sorting: [{ id: "company", desc: false }],
      pageSize: 1,
      pageIndex,
    });
    expect(value.total).toBe(2);
    expect(value.statusCounts).toEqual({
      all: 2,
      applied: 0,
      unapplied: 2,
      pending_review: 0,
    });
    rows.push(...value.rows);
  }
  expect(rows.map((row) => row.company)).toEqual(["Exact A", "Exact B"]);
  expect(rows.map((row) => row.screenshot_size_bytes)).toEqual([10240, 10240]);
  expect(rows.map((row) => row.screenshot_size_match_count)).toEqual([2, 2]);
  expect((await repeatedList({ pageIndex: 2, pageSize: 1 })).rows).toEqual([]);
  const sorted = await repeatedList({
    sorting: [{ id: "screenshot_size_bytes", desc: true }],
  });
  expect(sorted.rows.map((row) => row.company)).toEqual(["Exact A", "Exact B"]);
});

it("uses independent repeated eligibility for each status instead of adding disjoint counts", async () => {
  await changeCounterpart(
    "applied=true,rate_cents=125,application_method='manual',applied_at='2026-10-06 12:00Z'",
  );
  const counts = { all: 2, applied: 0, unapplied: 0, pending_review: 0 };
  const all = await repeatedList();
  expect(all.total).toBe(2);
  expect(all.statusCounts).toEqual(counts);
  expect(all.rows.map((row) => row.screenshot_size_match_count)).toEqual([
    2, 2,
  ]);
  for (const status of ["applied", "unapplied", "pending_review"]) {
    const value = await repeatedList({ status });
    expect(value.total).toBe(0);
    expect(value.rows).toEqual([]);
    expect(value.statusCounts).toEqual(counts);
  }
});

it("counts and displays repeats within the selected status while preserving other status snapshots", async () => {
  await db.exec("reset role");
  await attach(ids.Small, 10240);
  await db.query(
    "update public.bids set applied=true,rate_cents=125,application_method='manual',applied_at='2026-10-06 12:00Z' where id=any($1::uuid[])",
    [[ids["Exact A"], ids["Exact B"]]],
  );
  await db.query("update public.bids set review_status='pending' where id=$1", [
    ids.Small,
  ]);
  await asUser(owner);
  const applied = await repeatedList({ status: "applied" });
  expect(applied.total).toBe(2);
  expect(applied.statusCounts).toEqual({
    all: 3,
    applied: 2,
    unapplied: 0,
    pending_review: 0,
  });
  expect(applied.rows.map((row) => row.company)).toEqual([
    "Exact A",
    "Exact B",
  ]);
  expect(applied.rows.map((row) => row.screenshot_size_match_count)).toEqual([
    2, 2,
  ]);
  await changeCounterpart("review_status='pending'");
  const pending = await repeatedList({ status: "pending_review" });
  expect(pending.total).toBe(2);
  expect(pending.statusCounts).toEqual({
    all: 3,
    applied: 2,
    unapplied: 0,
    pending_review: 2,
  });
  expect(pending.rows.map((row) => row.company)).toEqual(["Small", "Exact B"]);
  expect(pending.rows.map((row) => row.screenshot_size_match_count)).toEqual([
    2, 2,
  ]);
});

it("uses found_at descending before id ascending for same-size ties", async () => {
  await changeCounterpart("found_at='2026-10-06 12:00Z'");
  const value = await list({
    sorting: [{ id: "screenshot_size_bytes", desc: false }],
  });
  expect(value.rows.map((row) => row.company)).toEqual([
    "Small",
    "Exact B",
    "Exact A",
    "Rounded",
    "Large",
    "Missing",
  ]);
});

it.each([
  [
    "period",
    "found_at='2026-10-01 12:00Z'",
    { rangeFrom: "2026-10-03T00:00:00Z", rangeTo: "2026-10-08T00:00:00Z" },
  ],
  [
    "status",
    "applied=true,rate_cents=125,application_method='manual',applied_at='2026-10-06 12:00Z'",
    { status: "unapplied" },
  ],
  [
    "search",
    "company='Hidden',url='https://hidden.test/job',normalized_url='https://hidden.test/job'",
    { search: "Exact" },
  ],
  ["column", "company='Hidden'", { columnFilters: { company: "Exact" } }],
  ["bidder", "source='LinkedIn'", { bidder }],
  ["embedded bidder", "source='LinkedIn'", { scopeBidderId: bidder }],
  [
    "bidder name",
    "source='LinkedIn'",
    { columnFilters: { bidder_id: "First bidder" } },
  ],
  [
    "profile name",
    "source='LinkedIn'",
    { columnFilters: { resume_id: "Main profile" } },
  ],
  ["assignment", "source='LinkedIn'", { resume: "USE_RESUME" }],
  ["trash", "deleted_at=now()", {}],
  ["source", "source='Other source'", { source: "LinkedIn" }],
  [
    "source column",
    "source='Other source'",
    { columnFilters: { source: "LinkedIn" } },
  ],
  ["arrangement", "arrangement='onsite'", { arrangement: "remote" }],
  ["job", "job_status='closed'", { job: "open" }],
  [
    "role column",
    "role_name='Architect'",
    { columnFilters: { role_name: "Engineer" } },
  ],
  [
    "URL column",
    "url='https://hidden.test/job',normalized_url='https://hidden.test/job'",
    { columnFilters: { url: "size.test" } },
  ],
  [
    "arrangement column",
    "arrangement='onsite'",
    { columnFilters: { arrangement: "remote" } },
  ],
  [
    "job column",
    "job_status='closed'",
    { columnFilters: { job_status: "open" } },
  ],
  [
    "review column",
    "review_status='pending'",
    { columnFilters: { review_status: "approved" } },
  ],
  [
    "applied column",
    "applied=true,rate_cents=125,application_method='manual',applied_at='2026-10-06 12:00Z'",
    { columnFilters: { applied: "Unapplied" } },
  ],
  [
    "interview column",
    "applied=true,rate_cents=125,application_method='manual',applied_at='2026-10-06 12:00Z',interview_scheduled=true",
    { columnFilters: { interview_scheduled: "Not scheduled" } },
  ],
  [
    "applied date presence",
    "applied=true,rate_cents=125,application_method='manual',applied_at='2026-10-06 12:00Z'",
    { columnFilters: { applied_at: { presence: "empty" } } },
  ],
  [
    "date column",
    "found_at='2026-10-01 12:00Z'",
    { columnFilters: { found_at: { from: "2026-10-03", to: "2026-10-07" } } },
  ],
] as const)(
  "excludes a same-size counterpart removed by the %s filter",
  async (_name, update, query) => {
    await changeCounterpart(update);
    const value = await list({
      ...query,
      ...("resume" in query ? { resume } : {}),
    });
    expect(exactA(value)).toMatchObject({
      screenshot_size_bytes: 10240,
      screenshot_size_match_count: 1,
    });
    expect(value.rows.map((row) => row.id)).not.toContain(ids["Exact B"]);
    const repeated = await repeatedList({
      ...query,
      ...("resume" in query ? { resume } : {}),
    });
    expect(repeated.total).toBe(0);
    expect(repeated.rows).toEqual([]);
    expect(repeated.statusCounts).toEqual({
      all: _name === "status" ? 2 : 0,
      applied: 0,
      unapplied: 0,
      pending_review: 0,
    });
  },
);

it("keeps statusCounts before selected status while counting sizes after it", async () => {
  await changeCounterpart(
    "applied=true,rate_cents=125,application_method='manual',applied_at='2026-10-06 12:00Z'",
  );
  const value = await list({ status: "unapplied" });
  expect(value.total).toBe(5);
  expect(value.statusCounts).toEqual({
    all: 6,
    applied: 1,
    unapplied: 5,
    pending_review: 0,
  });
  expect(exactA(value)?.screenshot_size_match_count).toBe(1);
  expect(value.sources).toEqual(["LinkedIn"]);
});

it("counts only the selected trash result", async () => {
  await db.exec("reset role");
  await db.query(
    "update public.bids set deleted_at=now() where id=any($1::uuid[])",
    [[ids["Exact A"], ids["Exact B"]]],
  );
  await asUser(owner);
  const value = await list({ trash: true });
  expect(value.total).toBe(2);
  expect(value.rows.map((row) => row.screenshot_size_match_count)).toEqual([
    2, 2,
  ]);
  expect((await repeatedList({ trash: true })).total).toBe(2);
  expect((await repeatedList()).total).toBe(0);
});

it("recalculates the entire repeated snapshot after period changes", async () => {
  await changeCounterpart("found_at='2026-10-01 12:00Z'");
  const all = await repeatedList({ pageSize: 1 });
  expect(all.total).toBe(2);
  expect(all.rows[0].screenshot_size_match_count).toBe(2);
  const narrowed = await repeatedList({
    rangeFrom: "2026-10-03T00:00:00Z",
    rangeTo: "2026-10-08T00:00:00Z",
    pageSize: 1,
  });
  expect(narrowed).toMatchObject({
    rows: [],
    total: 0,
    statusCounts: { all: 0, applied: 0, unapplied: 0, pending_review: 0 },
  });
  const restored = await repeatedList({ pageSize: 1 });
  expect(restored).toEqual(all);
});

it("gives admins cross-workspace counts while isolating client tenants", async () => {
  expect(exactA(await list())?.screenshot_size_match_count).toBe(2);
  expect((await repeatedList()).total).toBe(2);
  await asUser(other);
  const foreign = await list();
  expect(foreign.rows).toHaveLength(1);
  expect(foreign.rows[0]).toMatchObject({
    company: "Foreign",
    screenshot_size_match_count: 1,
  });
  expect((await repeatedList()).total).toBe(0);
  await asUser(admin);
  const all = await list();
  expect(all.total).toBe(7);
  expect(exactA(all)?.screenshot_size_match_count).toBe(3);
  expect((await repeatedList()).total).toBe(3);
  expect(
    all.rows.find((row) => row.company === "Foreign")
      ?.screenshot_size_match_count,
  ).toBe(3);
  expect(
    exactA(await list({ scopeBidderId: bidder }))?.screenshot_size_match_count,
  ).toBe(1);
  expect((await repeatedList({ scopeBidderId: bidder })).total).toBe(0);
});

it.each([
  ["unfinalized", { finalized: false }],
  ["wrong bid", { bid: ids.Small }],
  ["wrong bidder", { bidder: secondBidder }],
  [
    "wrong workspace",
    { workspace: "USE_FOREIGN_WORKSPACE", bidder: foreignBidder },
  ],
  ["resume file", { kind: "resume", resume: "USE_RESUME", bid: null }],
] as const)(
  "rejects %s current evidence metadata",
  async (_name, overrides) => {
    await db.exec("reset role");
    await attach(ids["Exact A"], 10240, {
      ...overrides,
      ...("resume" in overrides ? { resume } : {}),
      ...("workspace" in overrides ? { workspace: foreignWorkspace } : {}),
    });
    await asUser(admin); // Includes foreign files in RLS: identity checks must still reject them.
    const value = await list();
    expect(exactA(value)).toMatchObject({
      screenshot_size_bytes: null,
      screenshot_size_match_count: 0,
    });
    expect(
      value.rows.find((row) => row.id === ids["Exact B"])
        ?.screenshot_size_match_count,
    ).toBe(2);
    const repeated = await repeatedList();
    expect(repeated.total).toBe(2);
    expect(repeated.rows.map((row) => row.company)).toEqual([
      "Foreign",
      "Exact B",
    ]);
  },
);

it("replaces the current evidence snapshot without counting historical files", async () => {
  expect(exactA(await list())?.screenshot_size_match_count).toBe(2);
  await db.exec("reset role");
  await attach(ids["Exact A"], 10241);
  await asUser(owner);
  const replaced = await list();
  expect(exactA(replaced)).toMatchObject({
    screenshot_size_bytes: 10241,
    screenshot_size_match_count: 2,
  });
  expect(
    replaced.rows.find((row) => row.id === ids["Exact B"])
      ?.screenshot_size_match_count,
  ).toBe(1);
  expect((await repeatedList()).rows.map((row) => row.company)).toEqual([
    "Exact A",
    "Rounded",
  ]);
  await db.exec("reset role");
  await db.query("update public.bids set evidence_file_id=null where id=$1", [
    ids["Exact A"],
  ]);
  await asUser(owner);
  expect(exactA(await list())).toMatchObject({
    screenshot_size_bytes: null,
    screenshot_size_match_count: 0,
  });
  expect((await repeatedList()).total).toBe(0);
});

it("omits bidder metadata and handles unauthorized size sorting as an unsupported sort", async () => {
  await asUser(bidder);
  for (const desc of [false, true]) {
    const unsupported = await list({
      sorting: [{ id: "not_supported", desc }],
    });
    const size = await list({
      sorting: [{ id: "screenshot_size_bytes", desc }],
    });
    expect(size).toEqual(unsupported);
    expect(
      await repeatedList({ sorting: [{ id: "screenshot_size_bytes", desc }] }),
    ).toEqual(unsupported);
    expect(size.total).toBe(5);
    for (const row of size.rows) {
      expect(row).not.toHaveProperty("screenshot_size_bytes");
      expect(row).not.toHaveProperty("screenshot_size_match_count");
      expect(row).not.toHaveProperty("rate_cents");
    }
  }
});

it.each(["archived", "pending", "rejected"])(
  "requires an active approved manager for metadata (%s)",
  async (state) => {
    await db.exec("reset role");
    await db.query(
      "update public.profiles set archived=$1,approval_status=$2 where id=$3",
      [state === "archived", state === "archived" ? "approved" : state, admin],
    );
    await asUser(admin);
    const value = await list();
    expect(value.total).toBe(state === "archived" ? 0 : 7);
    expect(await repeatedList()).toEqual(value);
    for (const row of value.rows) {
      expect(row).not.toHaveProperty("screenshot_size_bytes");
      expect(row).not.toHaveProperty("screenshot_size_match_count");
    }
  },
);

it("denies anonymous execution and retains financial column boundaries for every authenticated role", async () => {
  for (const user of [owner, admin, bidder]) {
    await asUser(user);
    for (const row of (await list()).rows)
      expect(row).not.toHaveProperty("rate_cents");
    await expect(
      db.query("select rate_cents from public.bids"),
    ).rejects.toThrow(/permission denied/);
    // A SQL error aborts this test's transaction; recover before checking the next role.
    await db.exec("rollback; begin");
  }
  await db.exec("reset role; set role anon");
  await expect(list()).rejects.toThrow(/permission denied/);
});

it("preserves screenshot-presence filtering and sorting independently of valid size metadata", async () => {
  await db.exec("reset role");
  await attach(ids.Large, 100000, { finalized: false });
  await asUser(owner);
  const present = await list({
    columnFilters: { screenshot: "Has screenshot" },
  });
  expect(present.total).toBe(5);
  expect(present.rows.find((row) => row.id === ids.Large)).toMatchObject({
    screenshot_size_bytes: null,
    screenshot_size_match_count: 0,
  });
  const absent = await list({ columnFilters: { screenshot: "No screenshot" } });
  expect(absent.rows.map((row) => row.company)).toEqual(["Missing"]);
  const sorted = await list({ sorting: [{ id: "screenshot", desc: false }] });
  expect(sorted.rows[0].company).toBe("Missing");
});

it.each([2000, 10000])(
  "returns full-result counts for a realistic finalized manager dataset (%s screenshots)",
  async (count) => {
    await db.exec("reset role");
    await db.query(
      `insert into public.bids(workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,source,arrangement,found_at,review_status)
    select $1,$2,$3,'Batch '||n,'Engineer','https://batch.test/'||n,'https://batch.test/'||n,'LinkedIn','remote','2026-10-10 12:00Z'::timestamptz - n * interval '1 minute','approved'
    from generate_series(1,$4::integer) n`,
      [workspace, bidder, resume, count],
    );
    await db.query(
      `insert into public.files(workspace_id,bidder_id,kind,bid_id,filename,mime,size_bytes,storage_path,created_by,finalized,sha256,review_revision)
    select workspace_id,bidder_id,'screenshot',id,'proof.png','image/png',204800,id::text,$1,true,$2,review_revision from public.bids where company like 'Batch %'`,
      [owner, "b".repeat(64)],
    );
    await db.exec(
      "update public.bids b set evidence_file_id=f.id from public.files f where f.bid_id=b.id and b.company like 'Batch %'; analyze public.bids; analyze public.files",
    );
    for (const [user, role] of [
      [owner, "client"],
      [admin, "admin"],
      [bidder, "bidder"],
    ]) {
      await asUser(user);
      for (const sort of ["found_at", "screenshot_size_bytes"]) {
        const start = performance.now();
        const value = await list({
          search: "Batch",
          sorting: [{ id: sort, desc: true }],
          pageSize: 25,
          pageIndex: 40,
        });
        console.info(
          `screenshot-size query: ${role} ${sort}, ${count} finalized matches, ${Math.round(performance.now() - start)}ms`,
        );
        expect(value.total).toBe(count);
        expect(value.rows).toHaveLength(25);
        if (user === bidder) {
          for (const row of value.rows)
            expect(row).not.toHaveProperty("screenshot_size_bytes");
        } else {
          expect(
            value.rows.every(
              (row) =>
                row.screenshot_size_bytes === 204800 &&
                row.screenshot_size_match_count === count,
            ),
          ).toBe(true);
        }
      }
      console.info(
        `screenshot-size plan: ${role}, ${count} finalized screenshots, ${JSON.stringify(await explainListing(user !== bidder, user === bidder ? "found_at" : "screenshot_size_bytes"))}`,
      );
    }
  },
  60000,
);
