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
const file = "supabase/migrations/202610130024_dashboard_branch_groups.sql";
async function candidate() {
  await db.exec("reset role");
  if (existsSync(file)) await db.exec(readFileSync(file, "utf8"));
}
beforeAll(async () => {
  ({ db, actors } = await createFixture(1200));
  baseline = await definition(
    db,
    "private.dashboard_report_events(date,date,uuid,uuid,uuid)",
  );
  await db.query(
    `insert into public.retained_bid_daily_aggregates(workspace_id,bidder_id,profile_id,resume_id,report_day,metric,record_count,earned_cents,interview_count,tracked_count,remote_count,onsite_count,hybrid_count)
    values($1,$2,$3,$4,'2026-03-08','found',7,0,0,0,2,1,3),
    ($1,$2,$3,$4,'2026-03-08','earning',5,92233720368547000,2,4,0,0,0),
    ($1,$2,$3,$4,'2026-03-08','applied_activity',5,0,0,0,0,0,0)`,
    [
      actors.bidder.workspace,
      actors.bidder.id,
      actors.bidder.profile,
      actors.bidder.resume,
    ],
  );
}, 60000);
afterAll(async () => {
  await db?.close();
});

it("compresses each live metric branch before its combined aggregate", async () => {
  await candidate();
  await asActor(db, actors, "owner");
  await db.exec("reset role");
  let sql = (
    await db.query<{ prosrc: string }>(
      "select prosrc from pg_proc where oid='private.dashboard_report_events(date,date,uuid,uuid,uuid)'::regprocedure",
    )
  ).rows[0].prosrc;
  for (const [name, value] of Object.entries({
    p_from: "null::date",
    p_to: "null::date",
    p_workspace: "null::uuid",
    p_bidder: "null::uuid",
    p_profile: "null::uuid",
  }))
    sql = sql.replace(new RegExp(`\\b${name}\\b`, "g"), () => value);
  const plan = (
    await db.query<{ "QUERY PLAN": { Plan: Record<string, unknown> }[] }>(
      `explain(analyze,buffers,format json) ${sql}`,
    )
  ).rows[0]["QUERY PLAN"][0].Plan;
  function nodes(node: Record<string, unknown>): Record<string, unknown>[] {
    return [
      node,
      ...((node.Plans ?? []) as Record<string, unknown>[]).flatMap(nodes),
    ];
  }
  const unions = nodes(plan).filter((node) => node["Node Type"] === "Append");
  expect(unions.length).toBeGreaterThan(0);
  for (const union of unions)
    expect(Number(union["Actual Rows"])).toBeLessThan(1200);
});

it("preserves all report JSON, five grouping keys, twelve counters, CT bounds, history merges and financial projections", async () => {
  const cases = [];
  for (const actor of ["owner", "admin", "bidder", "outsider", null])
    for (const [from, to] of [
      [null, null],
      ["2026-03-08", "2026-03-08"],
      [null, "2026-03-08"],
      ["2026-03-08", null],
      ["2026-11-01", "2026-11-01"],
      ["2024-01-01", "2026-10-13"],
    ])
      for (const filtered of [false, true])
        cases.push({
          actor,
          params: [
            from,
            to,
            filtered ? actors.owner.workspace : null,
            filtered ? actors.bidder.id : null,
            filtered ? actors.bidder.profile : null,
          ],
        });
  async function read(params: unknown[]) {
    try {
      return (
        await db.query<{ result: unknown }>(
          "select public.dashboard_performance_v2($1,$2,$3,$4,$5) result",
          params,
        )
      ).rows[0].result;
    } catch (error) {
      return {
        error: (error as { code: string; message: string }).code,
        message: (error as Error).message,
      };
    }
  }
  await db.exec(`reset role;${baseline}`);
  const expected = [];
  for (const item of cases) {
    await asActor(db, actors, item.actor);
    expected.push(await read(item.params));
  }
  await candidate();
  for (let i = 0; i < cases.length; i++) {
    await asActor(db, actors, cases[i].actor);
    expect(await read(cases[i].params), JSON.stringify(cases[i])).toEqual(
      expected[i],
    );
  }
  await asActor(db, actors, "owner");
  await db.exec("reset role");
  const rows = await db.query(
    "select * from private.dashboard_report_events(null,null,null,null,null) order by day,metric,bidder_id,profile_id,resume_id",
  );
  await db.exec(baseline);
  expect(
    (
      await db.query(
        "select * from private.dashboard_report_events(null,null,null,null,null) order by day,metric,bidder_id,profile_id,resume_id",
      )
    ).rows,
  ).toEqual(rows.rows);
}, 120000);
