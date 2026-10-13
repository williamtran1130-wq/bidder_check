import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fixture as buildFixture } from "../scripts/screenshot-size-benchmark-helpers.mjs";

const migration =
  "supabase/migrations/202610120012_list_bids_counts_and_sort.sql";
const oldSource = readFileSync(
  "supabase/migrations/202610120011_list_bids_filtered_projection.sql",
  "utf8",
);
const readers = ["owner", "admin", "bidder1", "outsider"] as const;
const sorts = [
  "found_at",
  "resume_id",
  "company",
  "role_name",
  "url",
  "bidder_id",
  "source",
  "applied",
  "applied_at",
  "arrangement",
  "job_status",
  "review_status",
  "interview_scheduled",
  "screenshot",
  "screenshot_size_bytes",
];
type DataRow = Record<string, unknown>;
type Actor = { id: string; workspace: string; role: string };
type Fixture = {
  assignments: DataRow[];
  bids: DataRow[];
  files: DataRow[];
  finalBids: DataRow[];
};
type Listing = {
  rows: DataRow[];
  total: number;
  statusCounts: Record<string, number>;
  sources: string[];
};
interface Plan {
  [key: string]: unknown;
  Plans?: Plan[];
}
let db: PGlite;
const actors: Record<string, Actor> = {};
let resume: string;
async function oldFunction() {
  await db.exec(`reset role; ${oldSource}`);
}
async function newFunction() {
  await db.exec("reset role");
  if (existsSync(migration)) await db.exec(readFileSync(migration, "utf8"));
}
async function asUser(role: string) {
  await db.exec(
    "reset role;set role authenticated;set plan_cache_mode=force_generic_plan",
  );
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",
    [actors[role].id],
  );
}
async function read(query: object) {
  return (
    await db.query<{ value: Listing }>(
      "select public.list_bids_v2($1::jsonb) value",
      [JSON.stringify(query)],
    )
  ).rows[0].value;
}
function nodes(node: Plan): Plan[] {
  return [node, ...(node.Plans?.flatMap(nodes) ?? [])];
}
async function plan(sort: string) {
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
    page_index: "0",
    page_size: "7",
    sort_id: `'${sort}'`,
    sort_desc: "false",
    columns: "'{}'::jsonb",
    bidder_filter: "''",
    resume_filter: "''",
    bidder_matches: "null::uuid[]",
    resume_matches: "null::uuid[]",
    can_view_sizes: "true",
  };
  for (const [name, value] of Object.entries(locals))
    statement = statement.replace(
      new RegExp(`\\b${name}\\b`, "g"),
      () => value,
    );
  await db.exec("set plan_cache_mode=force_custom_plan");
  return (
    await db.query<{ "QUERY PLAN": { Plan: Plan }[] }>(
      `explain(analyze,buffers,format json) ${statement}`,
      [JSON.stringify({ search: "Count-main-", pageSize: 7 })],
    )
  ).rows[0]["QUERY PLAN"][0].Plan;
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);alter table storage.objects enable row level security;
    grant usage on schema auth,storage to authenticated,service_role;grant all on storage.objects to authenticated,service_role;`);
  for (const file of readdirSync("supabase/migrations")
    .filter((name) => name.endsWith(".sql") && name < "202610120012")
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  for (const label of ["owner", "admin", "bidder1", "bidder2", "outsider"]) {
    const id = randomUUID();
    await db.query("insert into auth.users(id,email) values($1,$2)", [
      id,
      `${label}@count.test`,
    ]);
    const workspace = (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_id=$1",
        [id],
      )
    ).rows[0].id;
    const role =
      label === "admin"
        ? "admin"
        : label.startsWith("bidder")
          ? "bidder"
          : "client";
    await db.query(
      "update public.profiles set role=$2,approval_status='approved' where id=$1",
      [id, role],
    );
    actors[label] = { id, workspace, role };
  }
  // Import the shared pure fixture directly; importing it never runs hosted work.
  const fixture = buildFixture(actors, "Count", "2026-10-12", 1200) as Fixture;
  for (const a of fixture.assignments) {
    await db.query(
      "insert into public.bidders(workspace_id,user_id) values($1,$2)",
      [a.workspace_id, a.bidder_id],
    );
    await db.query(
      "insert into public.candidate_profiles(id,workspace_id,identifier,candidate_name) values($1,$2,$3,$4)",
      [a.profile_id, a.workspace_id, a.identifier, a.candidate_name],
    );
    await db.query(
      "insert into public.resumes(id,workspace_id,bidder_id,profile_id,identifier,candidate_name) values($1,$2,$3,$4,$5,$6)",
      [
        a.id,
        a.workspace_id,
        a.bidder_id,
        a.profile_id,
        a.identifier,
        a.candidate_name,
      ],
    );
  }
  resume = String(fixture.assignments[0].id);
  async function insert(
    table: "bids" | "files",
    rows: DataRow[],
    upsert = false,
  ) {
    const keys = Object.keys(rows[0]);
    expect(keys.every((key) => /^[a-z_][a-z0-9_]*$/.test(key))).toBe(true);
    for (const row of rows) expect(Object.keys(row)).toEqual(keys);
    const columns = keys.join(",");
    const conflict = upsert
      ? ` on conflict(id) do update set ${keys
          .filter((key) => key !== "id")
          .map((key) => `${key}=excluded.${key}`)
          .join(",")}`
      : "";
    await db.query(
      `insert into public.${table}(${columns}) select ${columns} from jsonb_populate_recordset(null::public.${table},$1::jsonb)${conflict}`,
      [JSON.stringify(rows)],
    );
  }
  await db.exec(
    "select set_config('request.jwt.claim.role','service_role',false)",
  );
  await insert(
    "bids",
    fixture.bids.map((row) => ({ ...row, evidence_file_id: null })),
  );
  await insert("files", fixture.files);
  await insert("bids", fixture.finalBids, true);
  await db.exec("analyze;set work_mem='64kB'");
}, 60000);
afterAll(async () => {
  await db.close();
});

it("removes one count spool pass and skips the pre-page evidence join for ordinary sorting", async () => {
  await oldFunction();
  await asUser("owner");
  const before = await plan("found_at");
  await newFunction();
  await asUser("owner");
  const after = await plan("found_at");
  const evidenceScans = (root: Plan) =>
    nodes(root).filter((node) => node["CTE Name"] === "current_evidence_sizes");
  expect(evidenceScans(before)).toHaveLength(2);
  expect(evidenceScans(after)).toHaveLength(1);
  expect(
    nodes(after).filter((node) => node["CTE Name"] === "filtered"),
  ).toHaveLength(
    nodes(before).filter((node) => node["CTE Name"] === "filtered").length - 1,
  );
  expect(Number(after["Temp Read Blocks"])).toBeLessThan(
    Number(before["Temp Read Blocks"]),
  );
  for (const sort of ["found_at", "screenshot_size_bytes"]) {
    const root = await plan(sort);
    const evidence = nodes(root).filter(
      (node) => node["Subplan Name"] === "CTE current_evidence_sizes",
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]["Node Type"]).toBe("WindowAgg");
    expect(evidence[0]["Actual Loops"]).toBe(1);
    expect(evidenceScans(root)).toHaveLength(sort === "found_at" ? 1 : 2);
  }
});

it("preserves complete 011 output for all fifteen sorts, directions, pages and reader roles", async () => {
  const cases: { role: string; query: object; expected: Listing }[] = [];
  await oldFunction();
  for (const role of readers) {
    await asUser(role);
    const last = Math.max(
      0,
      Math.ceil(
        (await read({ search: "Count-main-", pageSize: 7 })).total / 7,
      ) - 1,
    );
    for (const id of sorts)
      for (const desc of [false, true])
        for (const pageIndex of [0, Math.floor(last / 2), last]) {
          const query = {
            search: "Count-main-",
            pageSize: 7,
            pageIndex,
            sorting: [{ id, desc }],
          };
          cases.push({ role, query, expected: await read(query) });
        }
  }
  await newFunction();
  for (const item of cases) {
    await asUser(item.role);
    expect(await read(item.query)).toEqual(item.expected);
  }
}, 120000);

it("preserves post-status total, pre-status counts and scoped evidence counts for empty and combined filters", async () => {
  const filters = [
    {},
    { search: "" },
    { search: "no matches" },
    { scopeBidderId: actors.bidder1.id },
    { bidder: actors.bidder1.id, resume },
    { source: "direct" },
    { arrangement: "remote", job: "open" },
    { trash: true },
    { rangeFrom: "2026-10-01T00:00:00Z", rangeTo: "2026-10-13T00:00:00Z" },
    { columnFilters: { company: "", role_name: "", screenshot: "" } },
    {
      columnFilters: {
        company: "main-1",
        applied: "Applied",
        review_status: "approved",
      },
    },
    {
      columnFilters: {
        screenshot: "Has screenshot",
        bidder_id: actors.bidder1.id,
        resume_id: "0",
      },
    },
    {
      columnFilters: {
        source: "direct",
        applied_at: { presence: "empty" },
        found_at: { presence: "has", from: "2026-10-01", to: "2026-10-12" },
      },
    },
  ];
  const cases: { role: string; query: object; expected: Listing }[] = [];
  await oldFunction();
  for (const role of readers) {
    await asUser(role);
    for (const status of [
      undefined,
      null,
      "",
      "unknown",
      "all",
      "applied",
      "unapplied",
      "pending_review",
    ])
      for (const filter of filters)
        for (const id of ["found_at", "screenshot_size_bytes"]) {
          const query = {
            pageSize: 7,
            sorting: [{ id, desc: false }],
            status,
            ...filter,
          };
          const expected = await read(query);
          if (status === "" || status === "unknown")
            expect(expected.total).toBe(0);
          cases.push({ role, query, expected });
        }
  }
  await newFunction();
  for (const item of cases) {
    await asUser(item.role);
    expect(await read(item.query)).toEqual(item.expected);
  }
}, 180000);

it("retains invoker, grants, custom-plan restoration, default memory and the financial boundary", async () => {
  const inspect = async () =>
    (
      await db.query<{
        prosecdef: boolean;
        provolatile: string;
        proconfig: string[];
        proowner: number;
        proacl: string[];
      }>(
        "select prosecdef,provolatile,proconfig,proowner,proacl::text[] from pg_proc where oid='public.list_bids_v2(jsonb)'::regprocedure",
      )
    ).rows[0];
  await oldFunction();
  const before = await inspect();
  await newFunction();
  expect(await inspect()).toEqual(before);
  await asUser("owner");
  const result = await read({ pageSize: 7 });
  expect(result.rows.length).toBeGreaterThan(0);
  expect(
    result.rows.every((row) => !("rate_cents" in row || "amount_cents" in row)),
  ).toBe(true);
  expect(
    (await db.query<{ work_mem: string }>("show work_mem")).rows[0].work_mem,
  ).toBe("64kB");
  expect(
    (await db.query<{ plan_cache_mode: string }>("show plan_cache_mode"))
      .rows[0].plan_cache_mode,
  ).toBe("force_generic_plan");
  await expect(read({ pageSize: "invalid" })).rejects.toThrow(
    /invalid input syntax/,
  );
  expect(
    (await db.query<{ plan_cache_mode: string }>("show plan_cache_mode"))
      .rows[0].plan_cache_mode,
  ).toBe("force_generic_plan");
  await asUser("bidder1");
  expect(
    (await read({})).rows.every(
      (row) =>
        !(
          "screenshot_size_bytes" in row || "screenshot_size_match_count" in row
        ),
    ),
  ).toBe(true);
  await db.exec("reset role;set role anon");
  await expect(read({})).rejects.toThrow(/permission denied/);
  await db.exec("reset role");
  for (const file of readdirSync("supabase/migrations")
    .filter(
      (name) =>
        name.endsWith(".sql") &&
        name > "202610120012_list_bids_counts_and_sort.sql",
    )
    .sort())
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  expect((await inspect()).proconfig).toContain(
    "plan_cache_mode=force_custom_plan",
  );
});
