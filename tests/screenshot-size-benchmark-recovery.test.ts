import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

mkdirSync(".superpowers/sdd/2026-10-12-screenshot-size-matching", {
  recursive: true,
});

type Row = Record<string, unknown>;
import { createBenchmarkRunner } from "../scripts/screenshot-size-benchmark-runner.mjs";

async function recoverInitialPlan(foreign = false) {
  const marker = `screenshot-size-bench-${randomUUID()}`;
  const accounts = ["owner", "admin", "bidder1", "bidder2", "outsider"].map(
    (label) => ({
      label,
      id: randomUUID(),
      email: `${marker}-${label}@example.com`,
    }),
  );
  const workspace = randomUUID(),
    bid = randomUUID(),
    file = randomUUID();
  const tables: Record<string, Row[]> = {
    profiles: accounts.map((a) => ({ id: a.id, email: a.email })),
    workspaces: [{ id: workspace, owner_id: accounts[0].id }],
    bids: [
      {
        id: bid,
        workspace_id: workspace,
        company: `${marker}-main`,
        evidence_file_id: file,
      },
    ],
    files: [
      {
        id: file,
        workspace_id: workspace,
        storage_path: `${marker}/image.png`,
      },
    ],
    resumes: [
      {
        id: randomUUID(),
        workspace_id: workspace,
        identifier: marker,
        file_id: file,
      },
    ],
    candidate_profiles: [
      { id: randomUUID(), workspace_id: workspace, identifier: marker },
    ],
    bidders: [{ user_id: accounts[2].id, workspace_id: workspace }],
    client_provisions: [{ id: accounts[0].id, email: accounts[0].email }],
    bid_events: [{ id: randomUUID(), bid_id: bid }],
    retained_bid_daily_aggregates: [],
    invitations: [],
    account_events: [],
    inbox_notifications: [],
  };
  const auth = new Map<string, string>(accounts.map((a) => [a.id, a.email]));
  if (foreign) auth.set(accounts[0].id, "foreign@example.invalid");
  const mutations: { table: string; ids: unknown[] }[] = [];
  function from(table: string) {
    const predicates: ((row: Row) => boolean)[] = [];
    let operation = "select",
      update: Row = {},
      slice: [number, number] | undefined;
    const query = {
      select: () => query,
      in: (column: string, values: unknown[]) => {
        predicates.push((row) => values.includes(row[column]));
        return query;
      },
      not: (column: string, operator: string, value: string) => {
        predicates.push((row) =>
          operator === "like"
            ? !String(row[column]).startsWith(value.slice(0, -1))
            : !value.slice(1, -1).split(",").includes(String(row[column])),
        );
        return query;
      },
      order: () => query,
      range: (start: number, end: number) => {
        slice = [start, end + 1];
        return query;
      },
      update: (value: Row) => {
        operation = "update";
        update = value;
        return query;
      },
      delete: () => {
        operation = "delete";
        return query;
      },
      then: (
        resolve: (response: {
          data: Row[];
          count: number;
          error: null;
        }) => unknown,
      ) => {
        let selected = (tables[table] ?? []).filter((row) =>
          predicates.every((test) => test(row)),
        );
        if (slice) selected = selected.slice(...slice);
        if (operation !== "select") {
          mutations.push({
            table,
            ids: selected.map((row) => row.id ?? row.user_id),
          });
          if (operation === "update")
            selected.forEach((row) => Object.assign(row, update));
          else
            tables[table] = tables[table].filter(
              (row) => !selected.includes(row),
            );
        }
        return Promise.resolve({
          data: structuredClone(selected),
          count: selected.length,
          error: null,
        }).then(resolve);
      },
    };
    return query;
  }
  const directory = mkdtempSync(
    ".superpowers/sdd/2026-10-12-screenshot-size-matching/recovery-plan-",
  );
  const receiptPath = path.join(directory, "initial-plan.json");
  // This is exactly the off-runner initial state: no progress, workspace IDs,
  // started flag or session information survives the simulated lost runner.
  writeFileSync(
    receiptPath,
    JSON.stringify({
      version: 1,
      target: "https://kdmvludtvhuuewmhurpw.supabase.co",
      marker,
      mode: "after",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fixtureBids: 25000,
      accounts,
      workspaceIds: [],
      results: [],
      phase: "planned",
      passed: false,
      cleanupComplete: false,
    }),
  );
  async function runRecovery() {
    const processStub = {
      argv: [
        "node",
        "benchmark",
        "--cleanup-only",
        "--staging-ready",
        "--receipt",
        receiptPath,
      ],
      env: {
        NEXT_PUBLIC_SUPABASE_URL: "https://kdmvludtvhuuewmhurpw.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-public",
        SUPABASE_SECRET_KEY: "test-secret",
      },
      cwd: () => process.cwd(),
      exitCode: 0,
    };
    await createBenchmarkRunner({
      assert,
      randomUUID,
      path,
      performance,
      console: { log: () => {}, error: () => {} },
      process: processStub,
      createClient: () => ({
        from,
        auth: {
          admin: {
            getUserById: async (id: string) => {
              assert.ok(accounts.some((a) => a.id === id));
              return auth.has(id)
                ? { data: { user: { email: auth.get(id) } }, error: null }
                : { error: { status: 404 } };
            },
            deleteUser: async (id: string) => {
              assert.ok(accounts.some((a) => a.id === id));
              auth.delete(id);
              return { error: null };
            },
          },
        },
      }),
      fetch: () => {
        throw new Error("Hosted fetch forbidden in recovery test");
      },
    }).run();
    return processStub.exitCode;
  }
  return { runRecovery, receiptPath, tables, auth, mutations };
}

describe("recovery from an off-runner initial plan", () => {
  it("discovers owned workspaces and cleans a partially seeded lost-runner fixture, idempotently", async () => {
    const fixture = await recoverInitialPlan();
    expect(await fixture.runRecovery()).toBe(0);
    const receipt = JSON.parse(readFileSync(fixture.receiptPath, "utf8"));
    expect(receipt.workspaceIds).toHaveLength(1);
    expect(receipt.cleanupComplete).toBe(true);
    expect(Object.values(receipt.cleanupCounts)).toHaveLength(14);
    expect(
      Object.values(receipt.cleanupCounts).every((value) => value === 0),
    ).toBe(true);
    expect(fixture.auth.size).toBe(0);
    expect(
      Object.values(fixture.tables).every((rows) => rows.length === 0),
    ).toBe(true);
    expect(await fixture.runRecovery()).toBe(0);
  });

  it("rejects a foreign identity before any database mutation", async () => {
    const fixture = await recoverInitialPlan(true);
    expect(await fixture.runRecovery()).toBe(1);
    expect(fixture.mutations).toHaveLength(0);
    expect(fixture.auth.size).toBe(5);
    expect(fixture.tables.bids).toHaveLength(1);
  });
});
