import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  assertFreshPlan,
  verifyUnusedPlan,
  claimPlan,
} from "../scripts/screenshot-size-benchmark-plan.mjs";

const target = "https://kdmvludtvhuuewmhurpw.supabase.co";
const root = ".superpowers/sdd/2026-10-12-screenshot-size-matching";
const script = "scripts/screenshot-size-staging-benchmark.mjs";
const source = readFileSync(script, "utf8");
const validateReceipt = runInNewContext(
  `(${source.slice(source.indexOf("function validateReceipt("), source.indexOf("async function save("))})`,
  {
    assert,
    STAGING: target,
    PREFIX: "screenshot-size-bench-",
    UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    LABELS: ["owner", "admin", "bidder1", "bidder2", "outsider"],
  },
);
function freshPlan() {
  const marker = `screenshot-size-bench-${randomUUID()}`;
  return {
    version: 1,
    target,
    marker,
    mode: "after",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fixtureBids: 25000,
    accounts: ["owner", "admin", "bidder1", "bidder2", "outsider"].map(
      (label) => ({
        label,
        id: randomUUID(),
        email: `${marker}-${label}@example.com`,
      }),
    ),
    workspaceIds: [],
    results: [],
    phase: "planned",
    passed: false,
    cleanupComplete: false,
  };
}
function unusedService(existing?: string, readError = false) {
  const reads: { table: string; column: string; ids: string[] }[] = [];
  const authIds: string[] = [];
  const service = {
    auth: {
      admin: {
        getUserById: async (id: string) => {
          authIds.push(id);
          return existing === "auth"
            ? { data: { user: { id } }, error: null }
            : {
                data: { user: null },
                error: {
                  status: readError ? 503 : 404,
                  code: readError ? "unavailable" : "user_not_found",
                },
              };
        },
      },
    },
    from: (table: string) => ({
      select: () => ({
        in: async (column: string, ids: string[]) => {
          reads.push({ table, column, ids });
          return {
            data: existing === table ? [{ id: ids[0] }] : [],
            error: readError ? { code: "unavailable" } : null,
          };
        },
      }),
    }),
  };
  return { service, reads, authIds };
}
const check = (response: { data: unknown; error: unknown }) => {
  assert.equal(response.error, null);
  return response.data;
};
function planCommand(extra: string[] = []) {
  const directory = mkdtempSync(path.join(root, "plan-test-"));
  const receipt = path.join(directory, "plan.json");
  const run = spawnSync(
    process.execPath,
    [script, "--plan-only", "--staging-ready", "--receipt", receipt, ...extra],
    {
      env: { NODE_ENV: "test", NEXT_PUBLIC_SUPABASE_URL: target },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  return { ...run, receipt };
}

describe("durable staging fixture plan", () => {
  it("creates recoverable identities without keys, sessions or hosted calls", () => {
    const run = planCommand();
    expect(run.status, run.stderr).toBe(0);
    const plan = JSON.parse(readFileSync(run.receipt, "utf8"));
    expect(plan).toMatchObject({
      target,
      mode: "after",
      phase: "planned",
      passed: false,
      cleanupComplete: false,
      fixtureBids: 25000,
      workspaceIds: [],
      results: [],
    });
    expect(plan.started).toBeUndefined();
    expect(plan.accounts.map((a: { label: string }) => a.label)).toEqual([
      "owner",
      "admin",
      "bidder1",
      "bidder2",
      "outsider",
    ]);
    expect(new Set(plan.accounts.map((a: { id: string }) => a.id)).size).toBe(
      5,
    );
    for (const actor of plan.accounts) {
      expect(actor.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(actor.email).toBe(`${plan.marker}-${actor.label}@example.com`);
    }
    expect(run.stdout).not.toContain("test-secret");
    expect(existsSync(`${run.receipt}.used`)).toBe(false);
  });

  it.each(["--before", "--cleanup-only", "--keep-fixture"])(
    "rejects incompatible %s before creating a plan",
    (flag) => {
      const run = planCommand([flag]);
      expect(run.status).toBe(1);
      expect(existsSync(run.receipt)).toBe(false);
    },
  );

  it("never overwrites a previous durable plan", () => {
    const first = planCommand();
    expect(first.status, first.stderr).toBe(0);
    const bytes = readFileSync(first.receipt);
    const second = spawnSync(
      process.execPath,
      [script, "--plan-only", "--staging-ready", "--receipt", first.receipt],
      {
        env: { NODE_ENV: "test", NEXT_PUBLIC_SUPABASE_URL: target },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(second.status).toBe(1);
    expect(readFileSync(first.receipt)).toEqual(bytes);
  });

  it("accepts only the exact fresh initial receipt shape", () => {
    const plan = freshPlan();
    expect(() => assertFreshPlan(plan, validateReceipt)).not.toThrow();
    for (const update of [
      { started: false },
      { phase: "seed" },
      { workspaceIds: [randomUUID()] },
      { results: [{}] },
      { mode: "before" },
      { passed: true },
      { cleanupComplete: true },
      { failure: {} },
      { createdAt: "2000-01-01T00:00:00.000Z" },
    ]) {
      expect(() =>
        assertFreshPlan({ ...plan, ...update }, validateReceipt),
      ).toThrow();
    }
    expect(() =>
      assertFreshPlan(
        {
          ...plan,
          accounts: plan.accounts.map((a, i) => ({
            ...a,
            id: i ? a.id : plan.accounts[1].id,
          })),
        },
        validateReceipt,
      ),
    ).toThrow();
    expect(() =>
      assertFreshPlan(
        {
          ...plan,
          accounts: plan.accounts.map((a) => ({ ...a, extra: true })),
        },
        validateReceipt,
      ),
    ).toThrow();
  });

  it("reads only the five planned IDs/emails and proves absence before writes", async () => {
    const plan = freshPlan(),
      fixture = unusedService();
    await verifyUnusedPlan(fixture.service, plan, check);
    expect(fixture.authIds).toEqual(plan.accounts.map((a) => a.id));
    expect(fixture.reads).toHaveLength(5);
    for (const read of fixture.reads)
      expect(read.ids).toEqual(
        plan.accounts.map((a) => (read.column === "email" ? a.email : a.id)),
      );
  });

  it.each(["auth", "profiles", "workspaces", "client_provisions"])(
    "rejects an already present %s identity without recreating anything",
    async (existing) => {
      const fixture = unusedService(existing);
      await expect(
        verifyUnusedPlan(fixture.service, freshPlan(), check),
      ).rejects.toThrow();
    },
  );

  it("fails closed when absence cannot be read", async () => {
    await expect(
      verifyUnusedPlan(
        unusedService(undefined, true).service,
        freshPlan(),
        check,
      ),
    ).rejects.toThrow();
  });

  it("claims an approved plan once and retains its digest for recovery", async () => {
    const directory = mkdtempSync(path.join(root, "plan-claim-test-"));
    const file = path.join(directory, "plan.json");
    const bytes = JSON.stringify(freshPlan());
    writeFileSync(file, bytes);
    await claimPlan(file, bytes);
    expect(JSON.parse(readFileSync(`${file}.used`, "utf8"))).toMatchObject({
      planSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(claimPlan(file, bytes)).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });
});
