import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "scripts/screenshot-size-staging-benchmark.mjs",
  "utf8",
);
const benchmark = source.slice(
  source.indexOf("async function benchmark("),
  source.indexOf("async function verifyCleanupScope("),
);
const main = source.slice(
  source.indexOf("async function main("),
  source.indexOf("function selfTest("),
);
const lifecycle = source.slice(
  source.lastIndexOf("} else {\n  try {\n    await main();") +
    "} else {".length,
  source.lastIndexOf("}"),
);

type Measurement = {
  p95Ms: number;
  maxMs: number;
  passed: boolean;
  samples: number;
  concurrency: number;
};
type Receipt = {
  passed: boolean;
  started?: boolean;
  fixtureRetained?: boolean;
  cleanupComplete: boolean;
  failure?: { code: string; phase: string };
  results: Measurement[];
};
type Scenario = {
  slowCase?: number;
  slowMs?: number;
  failure?: "provider" | "validation" | "scope" | "financial";
  failureCase?: number;
  before?: boolean;
};

// Execute the actual measurement function, main case matrix, and final cleanup
// orchestration. Only external setup, clock, and RPC results are substituted;
// no process environment, filesystem writes, or hosted requests are accessed.
async function runMatrix(scenario: Scenario = {}) {
  let clockCalls = 0;
  let timedReads = 0;
  let scopeChecks = 0;
  let financialChecks = 0;
  let cleanupCalls = 0;
  let signOutCalls = 0;
  let validationCalls = 0;
  const snapshots: Receipt[] = [];
  const processStub = {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://staging.invalid",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-public",
      SUPABASE_SECRET_KEY: "test-secret",
    },
    cwd: () => "/test",
    exitCode: 0,
  };
  function serviceQuery(table: string) {
    const response = {
      data: table === "profiles" ? [{ id: "synthetic-sponsor" }] : null,
      count: table === "bids" ? 25000 : 0,
      error: null,
    };
    const query = {
      select: () => query,
      eq: () => query,
      in: () => query,
      limit: () => query,
      insert: () => query,
      then: (resolve: (value: typeof response) => unknown) =>
        Promise.resolve(response).then(resolve),
    };
    return query;
  }
  const client = {
    rpc: async (
      _name: string,
      { p_query }: { p_query: { pageIndex?: number } },
    ) => {
      if (p_query.pageIndex === undefined) {
        scopeChecks++;
        return {
          data: { total: scenario.failure === "scope" ? 1 : 0, rows: [] },
          error: null,
        };
      }
      timedReads++;
      return {
        data: {},
        error:
          scenario.failure === "provider" &&
          timedReads === (scenario.failureCase ?? 0) * 25 + 1
            ? { code: "57014" }
            : null,
      };
    },
    from: () => ({
      select: () => ({
        limit: async () => {
          financialChecks++;
          return {
            error: {
              code: scenario.failure === "financial" ? "wrong" : "42501",
            },
          };
        },
      }),
    }),
    auth: {
      signOut: async ({ scope }: { scope: string }) => {
        assert.equal(scope, "local");
        signOutCalls++;
      },
    },
  };
  const context = {
    // Convert both arrays into the host realm for Node's prototype-sensitive
    // strict equality; the VM's real empty-scope assertion still executes.
    assert: Object.assign((value: unknown) => assert(value), assert, {
      deepEqual: (actual: unknown, expected: unknown) =>
        assert.deepEqual(structuredClone(actual), structuredClone(expected)),
    }),
    randomUUID,
    path,
    console: { log: () => {}, error: () => {} },
    process: processStub,
    STAGING: processStub.env.NEXT_PUBLIC_SUPABASE_URL,
    PREFIX: "screenshot-size-bench-",
    LABELS: ["owner", "admin", "bidder1", "bidder2", "outsider"],
    args: scenario.before
      ? ["--staging-ready", "--before"]
      : ["--staging-ready", "--keep-fixture"],
    before: !!scenario.before,
    recovery: false,
    keep: !scenario.before,
    failed: false,
    results: [] as Measurement[],
    sessions: [client],
    service: undefined,
    receipt: undefined as Receipt | undefined,
    receiptPath: undefined,
    fixtureData: undefined,
    options: {},
    option: () => undefined,
    guardedPath: (value: string) => value,
    validateReceipt: () => {},
    createClient: () => ({ from: serviceQuery }),
    save: async () => snapshots.push(structuredClone(context.receipt!)),
    account: async (planned: { id: string }, role: string) => ({
      id: planned.id,
      workspace: "synthetic-workspace",
      role,
      client,
    }),
    formatInTimeZone: () => "2026-10-12",
    fromZonedTime: () => new Date("2026-10-12T00:00:00Z"),
    shift: () => "2026-10-12",
    fixture: () => ({ files: [], assignments: [], bids: [], finalBids: [] }),
    chunks: async () => {},
    ok: (response: { error: { code: string } | null; data: unknown }) => {
      if (response.error) throw Object.assign(new Error(), response.error);
      return response.data;
    },
    expected: () => ({ rows: Array(500) }),
    validate: () => {
      validationCalls++;
      if (
        scenario.failure === "validation" &&
        validationCalls === (scenario.failureCase ?? 0) * 25 + 1
      )
        assert.fail("Incorrect RPC result");
    },
    performance: {
      now: () => {
        const caseIndex = Math.floor(clockCalls / 50);
        const wavePosition = clockCalls++ % 10;
        return wavePosition < 5
          ? 0
          : caseIndex === scenario.slowCase
            ? (scenario.slowMs ?? 2500)
            : 1000;
      },
    },
    cleanup: async () => {
      cleanupCalls++;
      context.receipt!.cleanupComplete = true;
      context.receipt!.fixtureRetained = false;
    },
  };
  await runInNewContext(
    `(async () => { ${benchmark}\n${main}\n${lifecycle} })()`,
    context,
  );
  return {
    receipt: context.receipt!,
    results: context.results,
    exitCode: processStub.exitCode,
    snapshots,
    timedReads,
    scopeChecks,
    financialChecks,
    cleanupCalls,
    signOutCalls,
  };
}

describe("staging benchmark matrix latency gate", () => {
  it("records all 21 cases after a latency failure, then fails and cleans despite keep", async () => {
    const run = await runMatrix({ slowCase: 0 });
    expect(run.results).toHaveLength(21);
    expect(run.results[0]).toMatchObject({
      p95Ms: 2500,
      maxMs: 2500,
      passed: false,
    });
    expect(
      run.results
        .slice(1)
        .every((result) => result.p95Ms === 1000 && result.passed),
    ).toBe(true);
    expect(
      run.results.every(
        (result) => result.samples === 25 && result.concurrency === 5,
      ),
    ).toBe(true);
    expect(run.timedReads).toBe(525);
    expect(run.scopeChecks).toBe(2);
    expect(run.financialChecks).toBe(3);
    expect(run.receipt.failure?.code).toBe("ERR_ASSERTION");
    expect(run.exitCode).toBe(1);
    expect(run.receipt.passed).toBe(false);
    expect(
      run.snapshots.every(
        (receipt) => !receipt.passed && !receipt.fixtureRetained,
      ),
    ).toBe(true);
    expect(run.cleanupCalls).toBe(1);
    expect(run.receipt.cleanupComplete).toBe(true);
    expect(run.receipt.fixtureRetained).toBe(false);
    expect(run.signOutCalls).toBe(1);
  });

  it("still rejects p95 exactly at the strict 2000ms threshold", async () => {
    const run = await runMatrix({ slowCase: 20, slowMs: 2000 });
    expect(run.results).toHaveLength(21);
    expect(run.results[20]).toMatchObject({ p95Ms: 2000, passed: false });
    expect(run.receipt.passed).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.cleanupCalls).toBe(1);
  });

  it.each(["provider", "validation"] as const)(
    "aborts immediately on a %s failure after settling the reader wave",
    async (failure) => {
      const run = await runMatrix({ failure });
      expect(run.timedReads).toBe(5);
      expect(run.results).toHaveLength(0);
      expect(run.scopeChecks).toBe(0);
      expect(run.financialChecks).toBe(0);
      expect(run.exitCode).toBe(1);
      expect(run.receipt.passed).toBe(false);
      expect(run.cleanupCalls).toBe(1);
      expect(run.signOutCalls).toBe(1);
    },
  );

  it.each(["provider", "validation"] as const)(
    "still aborts on a later %s failure after recording an earlier latency failure",
    async (failure) => {
      const run = await runMatrix({ slowCase: 0, failure, failureCase: 1 });
      expect(run.timedReads).toBe(30);
      expect(run.results).toHaveLength(1);
      expect(run.results[0].passed).toBe(false);
      expect(run.scopeChecks).toBe(0);
      expect(run.exitCode).toBe(1);
      expect(run.receipt.passed).toBe(false);
      expect(run.cleanupCalls).toBe(1);
      expect(run.receipt.fixtureRetained).toBe(false);
    },
  );

  it.each(["scope", "financial"] as const)(
    "never retains a fast matrix that fails the final %s correctness check",
    async (failure) => {
      const run = await runMatrix({ failure });
      expect(run.results).toHaveLength(21);
      expect(run.results.every((result) => result.passed)).toBe(true);
      expect(run.receipt.passed).toBe(false);
      expect(run.exitCode).toBe(1);
      expect(run.cleanupCalls).toBe(1);
      expect(run.receipt.fixtureRetained).toBe(false);
    },
  );

  it("retains only a fully passed post matrix with every correctness check passed", async () => {
    const run = await runMatrix();
    expect(run.results).toHaveLength(21);
    expect(run.scopeChecks).toBe(2);
    expect(run.financialChecks).toBe(3);
    expect(run.receipt.passed).toBe(true);
    expect(run.exitCode).toBe(0);
    expect(run.receipt.fixtureRetained).toBe(true);
    expect(run.cleanupCalls).toBe(0);
    expect(run.signOutCalls).toBe(1);
  });

  it("also completes the six-case pre008 baseline before failing a latency gate and cleaning", async () => {
    const run = await runMatrix({ before: true, slowCase: 0 });
    expect(run.results).toHaveLength(6);
    expect(run.timedReads).toBe(150);
    expect(run.results[0].passed).toBe(false);
    expect(run.receipt.passed).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.cleanupCalls).toBe(1);
  });
});
