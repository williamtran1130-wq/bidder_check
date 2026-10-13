import { afterAll, beforeAll, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  asActor,
  createFixture,
  definition,
  type FixtureActors,
} from "./helpers/sql-performance-fixture.mjs";
import type { PGlite } from "@electric-sql/pglite";

let db: PGlite;
let actors: FixtureActors;
let baseline: string;
const file =
  "supabase/migrations/202610130020_scoped_counts_delete_indexes.sql";
async function candidate() {
  await db.exec("reset role");
  if (existsSync(file)) await db.exec(readFileSync(file, "utf8"));
}
beforeAll(async () => {
  ({ db, actors } = await createFixture(1200));
  baseline = await definition(db, "public.resume_bid_counts()");
}, 60000);
afterAll(async () => {
  await db?.close();
});

it("evaluates readable membership per statement rather than once per bid", async () => {
  await candidate();
  await db.exec("begin");
  try {
    const original = await definition(db, "public.can_read(uuid,uuid)");
    await db.exec(
      original.replace(
        "public.can_read",
        "public.performance_original_can_read",
      ),
    );
    await db.exec(`create sequence public.performance_scope_calls;
      create or replace function public.can_read(w uuid,b uuid) returns boolean language plpgsql stable security definer set search_path='' as $$
      begin perform nextval('public.performance_scope_calls'); return public.performance_original_can_read(w,b); end $$;`);
    await asActor(db, actors, "owner");
    await db.query("select public.resume_bid_counts()");
    await db.exec("reset role");
    const calls = Number(
      (
        await db.query<{ last_value: number }>(
          "select last_value from public.performance_scope_calls",
        )
      ).rows[0].last_value,
    );
    expect(calls).toBeLessThan(100);
  } finally {
    await db.exec("rollback;reset role");
  }
});

it("preserves full counts and invoker visibility for roles, service claims, disabled owners and archived memberships", async () => {
  const roles = ["owner", "admin", "bidder", "outsider", null];
  await db.exec(`reset role; ${baseline}`);
  const expected = new Map<string, unknown>();
  for (const service of [false, true])
    for (const name of roles) {
      await asActor(db, actors, name, service);
      expected.set(
        `${service}:${name}`,
        (
          await db.query<{ result: unknown }>(
            "select public.resume_bid_counts() result",
          )
        ).rows[0].result,
      );
    }
  await candidate();
  for (const service of [false, true])
    for (const name of roles) {
      await asActor(db, actors, name, service);
      expect(
        (
          await db.query<{ result: unknown }>(
            "select public.resume_bid_counts() result",
          )
        ).rows[0].result,
      ).toEqual(expected.get(`${service}:${name}`));
    }
  await db.exec("reset role;begin");
  try {
    await db.query("update public.profiles set archived=true where id=$1", [
      actors.owner.id,
    ]);
    await asActor(db, actors, "bidder");
    expect(
      (
        await db.query<{ result: unknown }>(
          "select public.resume_bid_counts() result",
        )
      ).rows[0].result,
    ).toEqual({});
    await db.exec("reset role");
    expect(
      (
        await db.query(
          "select prosecdef from pg_proc where oid='public.resume_bid_counts()'::regprocedure",
        )
      ).rows,
    ).toEqual([{ prosecdef: false }]);
  } finally {
    await db.exec("rollback;reset role");
  }
});

it.each([
  ["files", "bid_id"],
  ["files", "resume_id"],
  ["bids", "evidence_file_id"],
  ["bid_events", "file_id"],
])(
  "has a usable leading delete-path index for %s.%s",
  async (table, column) => {
    await candidate();
    const indexes = (
      await db.query<{ n: number }>(
        `select count(*)::integer n from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0]
    where i.indrelid=$1::regclass and a.attname=$2 and i.indisvalid and i.indisready`,
        [`public.${table}`, column],
      )
    ).rows[0].n;
    expect(indexes).toBeGreaterThan(0);
  },
);

it("reuses equivalent leading indexes and repairs a partial index that omits relevant references", async () => {
  await candidate();
  await db.exec("reset role;begin");
  try {
    await db.exec(
      "drop index public.files_bid_delete_lookup;create index performance_existing_bid_lookup on public.files(bid_id,kind) where bid_id is not null;drop index public.files_resume_delete_lookup;create index performance_incomplete_resume_lookup on public.files(resume_id) where bid_id is not null",
    );
    await candidate();
    expect(
      (
        await db.query<{ present: boolean }>(
          "select to_regclass('public.files_bid_delete_lookup') is not null present",
        )
      ).rows[0].present,
    ).toBe(false);
    expect(
      (
        await db.query<{ present: boolean }>(
          "select to_regclass('public.files_resume_delete_lookup') is not null present",
        )
      ).rows[0].present,
    ).toBe(true);
  } finally {
    await db.exec("rollback;reset role");
  }
});
