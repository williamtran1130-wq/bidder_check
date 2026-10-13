import { afterAll, beforeAll, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import {
  asActor,
  createFixture,
  definition,
  type FixtureActors,
} from "./helpers/sql-performance-fixture.mjs";
let db: PGlite;
let actors: FixtureActors;
let baseline: string;
const file = "supabase/migrations/202610130023_ordinary_list_page.sql";
async function candidate() {
  await db.exec("reset role");
  if (existsSync(file)) await db.exec(readFileSync(file, "utf8"));
}
async function listing(query: object) {
  return (
    await db.query<{ result: unknown }>(
      "select public.list_bids_v2($1::jsonb) result",
      [JSON.stringify(query)],
    )
  ).rows[0].result;
}
async function observedListing(query: object) {
  try {
    return { result: await listing(query) };
  } catch (error) {
    return {
      code: (error as { code: string }).code,
      message: (error as Error).message,
    };
  }
}
beforeAll(async () => {
  ({ db, actors } = await createFixture(180));
  baseline = await definition(db, "public.list_bids_v2(jsonb)");
}, 60000);
afterAll(async () => {
  await db?.close();
});

async function compare(
  cases: { actor: string | null; query: object; service?: boolean }[],
) {
  await db.exec(`reset role;${baseline}`);
  const expected = [];
  for (const item of cases) {
    await asActor(db, actors, item.actor, item.service);
    expected.push(await observedListing(item.query));
  }
  await candidate();
  for (let i = 0; i < cases.length; i++) {
    await asActor(db, actors, cases[i].actor, cases[i].service);
    expect(
      await observedListing(cases[i].query),
      JSON.stringify(cases[i]),
    ).toEqual(expected[i]);
  }
}

it("limits ordinary ordering work to an OFFSET/LIMIT page before any row-number window", async () => {
  await candidate();
  await asActor(db, actors, "owner");
  // Explain the actual final RPC's SELECT, with its declared locals bound to
  // the query below. The assertion is operator work, not a source-text marker.
  const body = (
    await db.query<{ prosrc: string }>(
      "select prosrc from pg_proc where oid='public.list_bids_v2(jsonb)'::regprocedure",
    )
  ).rows[0].prosrc;
  const start = body.indexOf("with filtered as not materialized");
  let sql = body.slice(start, body.indexOf(" into result;", start));
  const locals: Record<string, string> = {
    p_query: "($1::jsonb)",
    page_index: "0",
    page_size: "7",
    sort_id: "'found_at'",
    sort_desc: "true",
    columns: "'{}'::jsonb",
    bidder_filter: "''",
    resume_filter: "''",
    bidder_matches: "null::uuid[]",
    resume_matches: "null::uuid[]",
    can_view_sizes: "true",
  };
  for (const [name, value] of Object.entries(locals))
    sql = sql.replace(new RegExp(`\\b${name}\\b`, "g"), () => value);
  const plan = (
    await db.query<{ "QUERY PLAN": { Plan: Record<string, unknown> }[] }>(
      `explain(analyze,buffers,format json) ${sql}`,
      [JSON.stringify({ pageSize: 7, status: "pending_review" })],
    )
  ).rows[0]["QUERY PLAN"][0].Plan;
  function nodes(node: Record<string, unknown>): Record<string, unknown>[] {
    return [
      node,
      ...((node.Plans ?? []) as Record<string, unknown>[]).flatMap(nodes),
    ];
  }
  const windows = nodes(plan).filter((n) => n["Node Type"] === "WindowAgg");
  expect(windows.length).toBeGreaterThan(0);
  for (const window of windows) {
    expect(Number(window["Actual Rows"])).toBeLessThanOrEqual(7);
    for (const input of (window.Plans ?? []) as Record<string, unknown>[])
      expect(Number(input["Actual Rows"])).toBeLessThanOrEqual(7);
  }
});

it("preserves direct-caller invalid input results or errors even for empty scopes", async () => {
  const queries = [
    { columnFilters: { found_at: { from: "invalid" } } },
    { columnFilters: { found_at: { to: "invalid" } } },
    { columnFilters: { applied_at: { from: "invalid" } } },
    { columnFilters: { applied_at: { to: "invalid" } } },
    { rangeFrom: "invalid" },
    { rangeTo: "invalid" },
    { scopeBidderId: "invalid" },
    { pageIndex: "invalid" },
    { trash: "invalid" },
  ];
  const cases = [];
  for (const actor of ["owner", "bidder", "outsider", null])
    for (const query of queries) cases.push({ actor, query });
  await compare(cases);
});

it("preserves complete outputs across every sort, directions, arbitrary pages, page sizes and role projections", async () => {
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
    "invalid",
  ];
  const cases = [];
  for (const actor of ["owner", "admin", "bidder", "outsider", null])
    for (const id of sorts)
      for (const desc of [false, true])
        for (const [pageIndex, pageSize] of [
          [0, 7],
          [2, 10],
          [8, 25],
          [100, 100],
        ])
          cases.push({
            actor,
            query: { sorting: [{ id, desc }], pageIndex, pageSize },
          });
  await compare(cases);
}, 180000);

it("preserves status totals, broad sources, filtered size population, invalid current attachments and literal substring filters", async () => {
  const filters = [
    {},
    { trash: true },
    { search: "Literal %_\\" },
    { search: "Company 1" },
    { search: "no match" },
    { scopeBidderId: actors.bidder.id },
    { bidder: actors.second.id },
    { resume: actors.bidder.resume },
    { source: "Board" },
    { arrangement: "hybrid", job: "closed" },
    { rangeFrom: "2026-03-08T06:00:00Z", rangeTo: "2026-03-09T05:00:00Z" },
    { columnFilters: { screenshot: "Has screenshot" } },
    { columnFilters: { screenshot: "No screenshot" } },
    { columnFilters: { screenshot: "Repeated sizes only" } },
    {
      columnFilters: {
        company: "Company 1",
        role_name: "Role 1",
        source: "Board",
        url: "jobs.invalid",
      },
    },
    { columnFilters: { bidder_id: "bidder", resume_id: "Fixture candidate" } },
    {
      columnFilters: {
        applied: "Applied",
        review_status: "approved",
        interview_scheduled: "Scheduled",
        arrangement: "remote",
        job_status: "open",
      },
    },
    { columnFilters: { found_at: { from: "2026-03-08" } } },
    { columnFilters: { found_at: { to: "2026-03-08" } } },
    { columnFilters: { found_at: { from: "2026-03-08", to: "2026-03-08" } } },
    { columnFilters: { found_at: { presence: "empty" } } },
    { columnFilters: { applied_at: { from: "2026-03-08" } } },
    { columnFilters: { applied_at: { to: "2026-11-01" } } },
    { columnFilters: { applied_at: { presence: "empty" } } },
    { columnFilters: { applied_at: { presence: "has" } } },
  ];
  const cases = [];
  for (const actor of ["owner", "bidder", "outsider"])
    for (const status of [
      "all",
      "applied",
      "unapplied",
      "pending_review",
      "invalid",
    ])
      for (const filter of filters)
        cases.push({
          actor,
          query: { ...filter, status, pageSize: 10, pageIndex: 1 },
        });
  await compare(cases);
}, 180000);

it("preserves revocation and empty-scope behavior", async () => {
  await db.exec("reset role;begin");
  try {
    await db.query(
      "update public.profiles set approval_status='rejected' where id=$1",
      [actors.owner.id],
    );
    await compare([
      { actor: "bidder", query: {} },
      { actor: "owner", query: {} },
      { actor: "admin", query: {} },
    ]);
  } finally {
    await db.exec("rollback;reset role");
  }
});

it("preserves service invoker results and exact 23/25-hour CT day boundaries including one-sided and infinite bounds", async () => {
  await db.exec("reset role;begin");
  try {
    await db.query(
      "select set_config('request.jwt.claim.role','service_role',false)",
    );
    const times = [
      "2026-03-08T05:59:59.999999Z",
      "2026-03-08T06:00:00Z",
      "2026-03-09T04:59:59.999999Z",
      "2026-03-09T05:00:00Z",
      "2026-11-01T04:59:59.999999Z",
      "2026-11-01T05:00:00Z",
      "2026-11-02T05:59:59.999999Z",
      "2026-11-02T06:00:00Z",
      "-infinity",
      "infinity",
      "12000-01-01T00:00:00Z",
    ];
    for (let i = 0; i < times.length; i++)
      await db.query(
        "update public.bids set found_at=$1::timestamptz,applied_at=$1::timestamptz,source='CT boundary' where id=md5('bidder-bid-'||$2::text)::uuid",
        [times[i], (i + 1) * 2],
      );
    const cases: { actor: string | null; service?: boolean; query: object }[] =
      [];
    for (const service of [false, true])
      for (const actor of ["owner", "bidder", null])
        for (const column of ["found_at", "applied_at"])
          for (const day of [
            "2026-03-08",
            "2026-11-01",
            "-infinity",
            "infinity",
            "12000-01-01",
            "294277-01-01",
            "294276-12-31",
            "0001-01-01 BC",
          ])
            for (const bound of [
              { from: day },
              { to: day },
              { from: day, to: day },
            ])
              cases.push({
                actor,
                service,
                query: {
                  source: "CT boundary",
                  pageSize: 100,
                  columnFilters: { [column]: bound },
                },
              });
    await compare(cases);
    await candidate();
    await asActor(db, actors, "owner");
    for (const column of ["found_at", "applied_at"])
      for (const [day, indexes] of [
        ["2026-03-08", [2, 3]],
        ["2026-11-01", [6, 7]],
      ] as [string, number[]][]) {
        const result = (await listing({
          source: "CT boundary",
          pageSize: 100,
          columnFilters: { [column]: { from: day, to: day } },
        })) as { rows: { url: string }[]; total: number };
        expect(result.total).toBe(2);
        expect(
          result.rows
            .map((row) => Number(row.url.split("/").slice(-1)[0]))
            .sort((a, b) => a - b),
        ).toEqual(indexes.map((n) => n * 2));
      }
  } finally {
    await db.exec("rollback;reset role");
  }
});
