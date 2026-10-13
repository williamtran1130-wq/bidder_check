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
const file = "supabase/migrations/202610130025_reviewed_import_sets.sql";
async function candidate() {
  await db.exec("reset role");
  if (existsSync(file)) await db.exec(readFileSync(file, "utf8"));
}
const request = "25000000-0000-4000-8000-000000000001";
function row(n: number) {
  return {
    company: `Import unique ${n}`,
    role_name: "Engineer",
    url: `https://import.invalid/${n}?utm_source=ignored`,
    source: "Fixture",
    arrangement: "remote",
    job_status: "open",
  };
}
async function run(rows: object[], sources: number[]) {
  return (
    await db.query<{ result: Record<string, unknown> }>(
      "select public.import_bids_reviewed($1,'2026-01-01',$2,$3,$4) result",
      [actors.bidder.resume, JSON.stringify(rows), sources, request],
    )
  ).rows[0].result;
}
beforeAll(async () => {
  ({ db, actors } = await createFixture(12));
  baseline = await definition(
    db,
    "public.import_bids_reviewed(uuid,date,jsonb,integer[],uuid)",
  );
  const id = (
    await db.query<{ id: string }>(
      "insert into public.files(workspace_id,bidder_id,kind,resume_id,filename,mime,size_bytes,storage_path,created_by,finalized) values($1,$2,'resume',$3,'resume.pdf','application/pdf',100,'import/resume.pdf',$4,true) returning id",
      [
        actors.bidder.workspace,
        actors.bidder.id,
        actors.bidder.resume,
        actors.owner.id,
      ],
    )
  ).rows[0].id;
  await db.query("update public.resumes set file_id=$1 where id=$2", [
    id,
    actors.bidder.resume,
  ]);
}, 60000);
afterAll(async () => {
  await db?.close();
});

it("normalizes accepted URLs once in the insert/matching statement after validator normalization", async () => {
  await candidate();
  await db.exec("begin");
  try {
    const normalizer = await definition(db, "public.normalize_job_url(text)");
    await db.exec(
      normalizer.replace(
        "public.normalize_job_url",
        "public.performance_original_normalize",
      ),
    );
    await db.exec(`create sequence public.performance_normalize_calls;
   create or replace function public.normalize_job_url(u text) returns text language plpgsql immutable strict security definer set search_path='' as $$
   begin perform nextval('public.performance_normalize_calls');return public.performance_original_normalize(u);end $$;`);
    await asActor(db, actors, "bidder");
    const rows = Array.from({ length: 40 }, (_, i) => row(i + 1));
    const result = await run(
      rows,
      rows.map((_, i) => i + 1),
    );
    expect(result.ids).toHaveLength(40);
    await db.exec("reset role");
    expect(
      Number(
        (
          await db.query<{ last_value: number }>(
            "select last_value from public.performance_normalize_calls",
          )
        ).rows[0].last_value,
      ),
    ).toBeLessThanOrEqual(80);
  } finally {
    await db.exec("rollback;reset role");
  }
});

it("preserves input-order quota/duplicate acceptance, original source rows, skipped reasons, zero receipts and replay", async () => {
  const mixed = [
    { ...row(1), company: "Shared quota", url: "invalid" },
    { ...row(2), company: "Shared quota" },
    { ...row(2), company: "Shared quota" },
    { ...row(4), company: "Shared quota" },
  ];
  async function execute(sql: string, rows: object[], sources: number[]) {
    await db.exec(`reset role;${sql};begin`);
    try {
      await db.query(
        "update public.candidate_profiles set max_bids_per_company=1 where id=$1",
        [actors.bidder.profile],
      );
      await asActor(db, actors, "bidder");
      const result = await run(rows, sources);
      expect(await run(rows, sources)).toEqual(result);
      const normalized = { ...result, ids: (result.ids as string[]).length };
      await db.exec("reset role");
      const inserted = (
        await db.query(
          "select company,role_name,url,normalized_url,source,arrangement,job_status,found_at,applied,rate_cents,application_method from public.bids where source='Fixture' order by url",
        )
      ).rows;
      const idUrls = (
        await db.query(
          "select b.url from unnest($1::uuid[]) with ordinality requested(id,n) join public.bids b on b.id=requested.id order by requested.n",
          [result.ids],
        )
      ).rows;
      const receipts = (
        await db.query(
          "select count(*)::int n from public.bid_import_receipts where request_id=$1",
          [request],
        )
      ).rows;
      return { normalized, inserted, idUrls, receipts };
    } finally {
      await db.exec("rollback;reset role");
    }
  }
  const next = existsSync(file) ? readFileSync(file, "utf8") : baseline;
  for (const [rows, sources] of [
    [mixed, [41, 42, 43, 44]],
    [
      Array.from({ length: 500 }, (_, i) => ({
        ...row(i + 1),
        url: "invalid",
      })),
      Array.from({ length: 500 }, (_, i) => 500 - i),
    ],
    [
      Array.from({ length: 500 }, (_, i) => row(i + 1)),
      Array.from({ length: 500 }, (_, i) => 1000 - i),
    ],
  ] as [object[], number[]][]) {
    const old = await execute(baseline, rows, sources);
    expect(await execute(next, rows, sources)).toEqual(old);
  }
}, 120000);
