import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  assertFreshPlan,
  verifyUnusedPlan,
  claimPlan,
} from "../scripts/screenshot-size-benchmark-plan.mjs";

mkdirSync(".superpowers/sdd/2026-10-12-screenshot-size-matching", {
  recursive: true,
});

const source = readFileSync(
  "scripts/screenshot-size-staging-benchmark.mjs",
  "utf8",
);
const threshold = source.match(/^const P95_LIMIT_MS = \d+;$/m)?.[0] ?? "";
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
  matrixKind: "full" | "ordinary-baseline";
  role: string;
  range: string;
  scope: string;
  sort: string;
  descending: boolean;
  screenshotFilter: string;
  status: string;
  arrangement: string | null;
  p95LimitMs: number;
  p95Ms: number;
  maxMs: number;
  passed: boolean;
  samples: number;
  concurrency: number;
  requests: RequestTiming[];
};
type RequestTiming = {
  wave: number;
  reader: number;
  pageIndex: number;
  durationMs: number;
  errorCode: string | null;
};
type BenchmarkFailure = {
  caseNumber: number;
  role: string;
  range: string;
  scope: string;
  sort: string;
  descending: boolean;
  mode: string;
  status: string;
  wave: number;
  requests: RequestTiming[];
};
type Receipt = {
  phase?: string;
  matrixKind?: "full" | "ordinary-baseline";
  representativeBids?: number;
  fixtureVolumeMultiple?: number;
  p95LimitMs?: number;
  passed: boolean;
  started?: boolean;
  fixtureRetained?: boolean;
  cleanupComplete: boolean;
  failure?: { code: string; phase: string };
  results: Measurement[];
  benchmarkFailure?: BenchmarkFailure;
  diagnosticHold?: {
    seconds: number;
    completed: boolean;
    skipped?: boolean;
    elapsedMs?: number;
  };
};
type Scenario = {
  ordinaryOnly?: boolean;
  representativeBids?: string | null;
  slowCase?: number;
  slowMs?: number;
  failure?: "provider" | "validation" | "scope" | "financial" | "seed";
  failureCase?: number;
  failureReads?: number[];
  providerCode?: string;
  holdSeconds?: string;
  holdSaveFailure?: boolean;
  holdOvershoot?: boolean;
  before?: boolean;
  usePlan?: boolean;
};

// Execute the actual measurement function, main case matrix, and final cleanup
// orchestration. Only external setup, clock, and RPC results are substituted;
// no process environment, filesystem writes, or hosted requests are accessed.
async function runMatrix(scenario: Scenario = {}) {
  let setupCalls = 0;
  let clockCalls = 0;
  let timedReads = 0;
  let scopeChecks = 0;
  let financialChecks = 0;
  let cleanupCalls = 0;
  let signOutCalls = 0;
  let validationCalls = 0;
  const snapshots: Receipt[] = [];
  const queries: Record<string, unknown>[] = [];
  const featureChecks: boolean[] = [];
  const holdWaits: number[] = [];
  const holdLogs: Record<string, unknown>[] = [];
  let holdClock = 0;
  const planPath = scenario.usePlan
    ? path.join(
        mkdtempSync(
          ".superpowers/sdd/2026-10-12-screenshot-size-matching/matrix-plan-",
        ),
        "plan.json",
      )
    : undefined;
  if (planPath) {
    const marker = `screenshot-size-bench-${randomUUID()}`;
    writeFileSync(
      planPath,
      JSON.stringify({
        version: 1,
        target: "https://staging.invalid",
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
      }),
    );
  }
  const args = scenario.before
    ? ["--staging-ready", "--before"]
    : [
        "--staging-ready",
        "--keep-fixture",
        ...(planPath ? ["--use-plan", planPath] : []),
      ];
  if (scenario.representativeBids !== null)
    args.push("--representative-bids", scenario.representativeBids ?? "12000");
  if (scenario.ordinaryOnly) args.push("--ordinary-only");
  if (scenario.holdSeconds !== undefined)
    args.push("--diagnostic-hold-seconds", scenario.holdSeconds);
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
      in: () => {
        response.data = [];
        return query;
      },
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
      { p_query }: { p_query: { pageIndex?: number; [key: string]: unknown } },
    ) => {
      if (p_query.pageIndex === undefined) {
        scopeChecks++;
        return {
          data: { total: scenario.failure === "scope" ? 1 : 0, rows: [] },
          error: null,
        };
      }
      timedReads++;
      queries.push(structuredClone(p_query));
      return {
        data: {},
        error:
          scenario.failure === "provider" &&
          (scenario.failureReads ?? [1]).includes(
            timedReads - (scenario.failureCase ?? 0) * 25,
          )
            ? {
                code: scenario.providerCode ?? "57014",
                message: "PRIVATE raw provider message",
                details: "PRIVATE token and row values",
              }
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
    console: {
      log: (value: string) => {
        const event = JSON.parse(value);
        if (event.diagnosticHold) holdLogs.push(event);
      },
      error: () => {},
    },
    process: processStub,
    STAGING: processStub.env.NEXT_PUBLIC_SUPABASE_URL,
    PREFIX: "screenshot-size-bench-",
    LABELS: ["owner", "admin", "bidder1", "bidder2", "outsider"],
    args,
    before: !!scenario.before,
    recovery: false,
    keep: !scenario.before,
    failed: false,
    diagnosticHoldSeconds: 0,
    results: [] as Measurement[],
    sessions: [client],
    service: undefined,
    receipt: undefined as Receipt | undefined,
    receiptPath: undefined,
    fixtureData: undefined,
    options: {},
    option: (name: string) =>
      args.includes(name) ? args[args.indexOf(name) + 1] : undefined,
    guardedPath: (value: string) => value,
    validateReceipt: () => {},
    createClient: () => {
      setupCalls++;
      return {
        from: serviceQuery,
        auth: {
          admin: { getUserById: async () => ({ error: { status: 404 } }) },
        },
      };
    },
    readFile,
    assertFreshPlan,
    verifyUnusedPlan,
    claimPlan,
    save: async () => {
      if (
        scenario.holdSaveFailure &&
        context.receipt?.phase === "diagnostic-hold"
      )
        throw new Error("Synthetic receipt save failure");
      snapshots.push(structuredClone(context.receipt!));
    },
    account: async (planned: { id: string }, role: string) => {
      if (planPath)
        assert.ok(
          existsSync(`${planPath}.used`),
          "Claim must precede the first actor mutation",
        );
      return { id: planned.id, workspace: "synthetic-workspace", role, client };
    },
    formatInTimeZone: () => "2026-10-12",
    fromZonedTime: () => new Date("2026-10-12T00:00:00Z"),
    shift: () => "2026-10-12",
    fixture: () => ({ files: [], assignments: [], bids: [], finalBids: [] }),
    chunks: async () => {
      if (scenario.failure === "seed")
        throw new Error("Synthetic seed failure");
    },
    ok: (response: { error: { code: string } | null; data: unknown }) => {
      if (response.error) throw Object.assign(new Error(), response.error);
      return response.data;
    },
    expected: () => ({ rows: Array(500) }),
    validate: (
      _data: unknown,
      _expected: unknown,
      _actor: unknown,
      _page: number,
      _size: number,
      checkFeature: boolean,
    ) => {
      featureChecks.push(checkFeature);
      validationCalls++;
      if (
        scenario.failure === "validation" &&
        validationCalls === (scenario.failureCase ?? 0) * 25 + 1
      )
        assert.fail("Incorrect RPC result");
    },
    performance: {
      now: () => {
        if (context.receipt?.phase === "diagnostic-hold") return holdClock;
        const caseIndex = Math.floor(clockCalls / 50);
        const wavePosition = clockCalls++ % 10;
        return wavePosition < 5
          ? 0
          : caseIndex === scenario.slowCase
            ? (scenario.slowMs ?? 11000)
            : 1000;
      },
    },
    setTimeout: (resolve: () => void, milliseconds: number) => {
      holdWaits.push(milliseconds);
      holdClock += scenario.holdOvershoot ? 180000 : milliseconds;
      resolve();
    },
    cleanup: async () => {
      cleanupCalls++;
      context.receipt!.cleanupComplete = true;
      context.receipt!.fixtureRetained = false;
    },
  };
  await runInNewContext(
    `(async () => { ${threshold}\n${benchmark}\n${main}\n${lifecycle} })()`,
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
    setupCalls,
    queries,
    featureChecks,
    holdWaits,
    holdLogs,
  };
}

describe("staging benchmark matrix latency gate", () => {
  it("holds only explicit benchmark failures for a fixed monotonic bound after saving context, then cleans", async () => {
    const run = await runMatrix({ failure: "provider", holdSeconds: "120" });
    expect(run.holdWaits).toEqual([30000, 30000, 30000, 30000]);
    expect(run.holdLogs.map((event) => event.remainingSeconds)).toEqual([
      120, 90, 60, 30, 0,
    ]);
    const failureSaved = run.snapshots.findIndex(
      (snapshot) =>
        snapshot.failure?.code === "57014" && !!snapshot.benchmarkFailure,
    );
    const holdSaved = run.snapshots.findIndex(
      (snapshot) => snapshot.diagnosticHold?.seconds === 120,
    );
    expect(failureSaved).toBeGreaterThanOrEqual(0);
    expect(holdSaved).toBeGreaterThan(failureSaved);
    expect(run.receipt.diagnosticHold).toMatchObject({
      seconds: 120,
      completed: true,
      elapsedMs: 120000,
    });
    expect(run.timedReads).toBe(5);
    expect(run.cleanupCalls).toBe(1);
    expect(run.receipt.cleanupComplete).toBe(true);
    expect(run.exitCode).toBe(1);
    expect(run.signOutCalls).toBe(1);
  });
  it("does not reset the hold deadline after an external delay", async () => {
    const run = await runMatrix({
      failure: "provider",
      holdSeconds: "120",
      holdOvershoot: true,
    });
    expect(run.holdWaits).toEqual([30000]);
    expect(run.receipt.diagnosticHold).toMatchObject({
      completed: true,
      elapsedMs: 180000,
    });
    expect(run.cleanupCalls).toBe(1);
  });
  it.each([undefined, "0"])(
    "keeps default/zero hold behavior immediate",
    async (holdSeconds) => {
      const run = await runMatrix({ failure: "provider", holdSeconds });
      expect(run.holdWaits).toEqual([]);
      expect(run.receipt.diagnosticHold).toBeUndefined();
      expect(run.cleanupCalls).toBe(1);
    },
  );
  it("skips holds for nonbenchmark failures and fully passed runs", async () => {
    for (const scenario of [{ failure: "seed" as const }, {}]) {
      const run = await runMatrix({ ...scenario, holdSeconds: "120" });
      expect(run.holdWaits).toEqual([]);
      expect(run.receipt.diagnosticHold).toBeUndefined();
    }
  });
  it("skips an unpersisted diagnostic hold and still executes cleanup", async () => {
    const run = await runMatrix({
      failure: "provider",
      holdSeconds: "120",
      holdSaveFailure: true,
    });
    expect(run.holdWaits).toEqual([]);
    expect(run.receipt.diagnosticHold).toMatchObject({
      completed: false,
      skipped: true,
    });
    expect(run.receipt.failure?.code).toBe("57014");
    expect(run.cleanupCalls).toBe(1);
    expect(run.exitCode).toBe(1);
  });
  it.each(["", "-1", "121", "1.5", "Infinity", "1e2", "NaN"])(
    "rejects invalid hold %s before hosted setup",
    async (holdSeconds) => {
      const run = await runMatrix({ holdSeconds });
      expect(run.setupCalls).toBe(0);
      expect(run.receipt).toBeUndefined();
      expect(run.holdWaits).toEqual([]);
      expect(run.exitCode).toBe(1);
    },
  );

  it("persists every settled reader in a failed later wave before cleanup, including successful siblings", async () => {
    const run = await runMatrix({
      failure: "provider",
      failureCase: 6,
      failureReads: [11, 14],
    });
    expect(run.timedReads).toBe(165);
    expect(run.results).toHaveLength(6);
    const diagnostic = run.receipt.benchmarkFailure;
    expect(diagnostic).toMatchObject({
      caseNumber: 7,
      role: "client",
      range: "recent",
      scope: "main",
      sort: "found_at",
      descending: true,
      mode: "ordinary",
      status: "all",
      wave: 3,
    });
    expect(diagnostic?.requests).toHaveLength(15);
    expect(diagnostic?.requests.slice(-5)).toEqual([
      {
        wave: 3,
        reader: 1,
        pageIndex: 0,
        durationMs: 1000,
        errorCode: "57014",
      },
      { wave: 3, reader: 2, pageIndex: 1, durationMs: 1000, errorCode: null },
      { wave: 3, reader: 3, pageIndex: 2, durationMs: 1000, errorCode: null },
      {
        wave: 3,
        reader: 4,
        pageIndex: 3,
        durationMs: 1000,
        errorCode: "57014",
      },
      { wave: 3, reader: 5, pageIndex: 4, durationMs: 1000, errorCode: null },
    ]);
    expect(
      run.snapshots.some(
        (snapshot) =>
          snapshot.benchmarkFailure?.requests.length === 15 &&
          !snapshot.cleanupComplete,
      ),
    ).toBe(true);
    expect(run.receipt.failure?.code).toBe("57014");
    expect(run.cleanupCalls).toBe(1);
    expect(run.receipt.cleanupComplete).toBe(true);
    expect(run.exitCode).toBe(1);
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /PRIVATE|synthetic|p_query|search|workspace_id|bidder_id|token|message|details/,
    );
  });

  it("stores raw per-request timings for every completed case without changing matrix volume or p95", async () => {
    const run = await runMatrix({ slowCase: 56, slowMs: 9999.999 });
    expect(run.timedReads).toBe(1425);
    expect(run.results).toHaveLength(57);
    expect(
      run.results.every((measurement) => measurement.requests?.length === 25),
    ).toBe(true);
    expect(
      run.results[56].requests?.map((request) => request.durationMs),
    ).toEqual(Array(25).fill(9999.999));
    expect(run.results[56]).toMatchObject({
      p95Ms: 9999.999,
      maxMs: 10000,
      passed: true,
      samples: 25,
      concurrency: 5,
    });
    expect(
      run.results[56].requests
        ?.slice(0, 5)
        .map((request) => [
          request.wave,
          request.reader,
          request.pageIndex,
          request.errorCode,
        ]),
    ).toEqual([
      [1, 1, 0, null],
      [1, 2, 1, null],
      [1, 3, 2, null],
      [1, 4, 3, null],
      [1, 5, 4, null],
    ]);
    expect(run.receipt.benchmarkFailure).toBeUndefined();
  });

  it("captures validation failures after their original raw RPC timing and withholds unrecognized provider codes", async () => {
    const validation = await runMatrix({ failure: "validation" });
    expect(validation.receipt.benchmarkFailure?.requests).toHaveLength(5);
    expect(validation.receipt.benchmarkFailure?.requests[0]).toMatchObject({
      durationMs: 1000,
      errorCode: "ERR_ASSERTION",
    });
    const provider = await runMatrix({
      failure: "provider",
      providerCode: "PRIVATE-secret-code",
    });
    expect(provider.receipt.benchmarkFailure?.requests[0].errorCode).toBe(
      "UNKNOWN",
    );
    expect(JSON.stringify(provider.receipt.benchmarkFailure)).not.toContain(
      "PRIVATE",
    );
  });

  it("records all 57 cases after a latency failure, then fails and cleans despite keep", async () => {
    const run = await runMatrix({ slowCase: 0 });
    expect(run.results).toHaveLength(57);
    expect(run.results[0]).toMatchObject({
      p95Ms: 11000,
      maxMs: 11000,
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
    expect(run.timedReads).toBe(1425);
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

  it("accepts p95 just below the authorized 10000ms threshold with complete correctness checks", async () => {
    const run = await runMatrix({ slowCase: 56, slowMs: 9999 });
    expect(run.results).toHaveLength(57);
    expect(run.results[56]).toMatchObject({
      p95Ms: 9999,
      p95LimitMs: 10000,
      passed: true,
    });
    expect(run.results.every((result) => result.p95LimitMs === 10000)).toBe(
      true,
    );
    expect(run.receipt.p95LimitMs).toBe(10000);
    expect(run.timedReads).toBe(1425);
    expect(run.scopeChecks).toBe(2);
    expect(run.financialChecks).toBe(3);
    expect(run.receipt.passed).toBe(true);
    expect(run.receipt.fixtureRetained).toBe(true);
    expect(run.exitCode).toBe(0);
    expect(run.cleanupCalls).toBe(0);
  });

  it("still rejects p95 exactly at the strict 10000ms threshold", async () => {
    const run = await runMatrix({ slowCase: 56, slowMs: 10000 });
    expect(run.results).toHaveLength(57);
    expect(run.results[56]).toMatchObject({ p95Ms: 10000, passed: false });
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
      expect(run.results).toHaveLength(57);
      expect(run.results.every((result) => result.passed)).toBe(true);
      expect(run.receipt.passed).toBe(false);
      expect(run.exitCode).toBe(1);
      expect(run.cleanupCalls).toBe(1);
      expect(run.receipt.fixtureRetained).toBe(false);
    },
  );

  it("retains only a fully passed post matrix with every correctness check passed", async () => {
    const run = await runMatrix();
    expect(run.results).toHaveLength(57);
    expect(run.scopeChecks).toBe(2);
    expect(run.financialChecks).toBe(3);
    expect(run.receipt.passed).toBe(true);
    expect(run.exitCode).toBe(0);
    expect(run.receipt.fixtureRetained).toBe(true);
    expect(run.cleanupCalls).toBe(0);
    expect(run.signOutCalls).toBe(1);
  });

  it("executes the same complete matrix using durably planned identities", async () => {
    const run = await runMatrix({ usePlan: true });
    expect(run.timedReads).toBe(1425);
    expect(run.results).toHaveLength(57);
    expect(run.receipt.passed).toBe(true);
    expect(run.receipt.p95LimitMs).toBe(10000);
    expect(run.receipt.fixtureRetained).toBe(true);
    expect(run.cleanupCalls).toBe(0);
  });

  it("planned execution still fails and cleans every scope after a provider error", async () => {
    const run = await runMatrix({ usePlan: true, failure: "provider" });
    expect(run.timedReads).toBe(5);
    expect(run.receipt.passed).toBe(false);
    expect(run.cleanupCalls).toBe(1);
    expect(run.receipt.cleanupComplete).toBe(true);
    expect(run.receipt.fixtureRetained).toBe(false);
    expect(run.exitCode).toBe(1);
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

  it("sends both repeated size directions, every status, ordinary baselines and forbidden bidder modes", async () => {
    const run = await runMatrix();
    expect(run.results.filter((r) => r.screenshotFilter === "")).toHaveLength(
      21,
    );
    const repeated = run.results.filter(
      (r) => r.screenshotFilter === "Repeated sizes only",
    );
    expect(repeated).toHaveLength(36);
    for (const role of ["client", "admin"]) {
      for (const status of ["all", "applied", "unapplied", "pending_review"]) {
        for (const descending of [false, true]) {
          expect(
            repeated.some(
              (r) =>
                r.role === role &&
                r.status === status &&
                r.sort === "screenshot_size_bytes" &&
                r.descending === descending,
            ),
          ).toBe(true);
        }
      }
    }
    expect(repeated.filter((r) => r.role === "bidder")).toHaveLength(6);
    expect(
      repeated.filter((r) => r.scope === "authorized-cross-workspace"),
    ).toHaveLength(2);
    expect(repeated.filter((r) => r.scope === "filtered-bidder")).toHaveLength(
      2,
    );
    expect(repeated.filter((r) => r.arrangement === "remote")).toHaveLength(2);
    expect(
      run.queries.filter(
        (q) =>
          (q.columnFilters as Record<string, unknown>)?.screenshot ===
          "Repeated sizes only",
      ),
    ).toHaveLength(900);
    expect(run.receipt).toMatchObject({
      representativeBids: 12000,
      fixtureVolumeMultiple: 25000 / 12000,
      matrixKind: "full",
    });
    expect(run.results.every((r) => r.matrixKind === "full")).toBe(true);
  });

  it("runs the original 21 ordinary cases with current metadata in ordinary-only mode", async () => {
    const run = await runMatrix({ ordinaryOnly: true, usePlan: true });
    expect(run.exitCode).toBe(0);
    expect(run.results).toHaveLength(21);
    expect(run.timedReads).toBe(525);
    expect(run.receipt).toMatchObject({
      matrixKind: "ordinary-baseline",
      mode: "after",
      passed: true,
      fixtureVolumeMultiple: 25000 / 12000,
    });
    expect(run.featureChecks).toHaveLength(525);
    expect(run.featureChecks.every(Boolean)).toBe(true);
    expect(
      run.results.every(
        (r) =>
          r.matrixKind === "ordinary-baseline" && r.screenshotFilter === "",
      ),
    ).toBe(true);
    expect(
      run.queries.every(
        (q) => (q.columnFilters as Record<string, unknown>)?.screenshot === "",
      ),
    ).toBe(true);
    expect(run.scopeChecks).toBe(2);
    expect(run.financialChecks).toBe(3);
    expect(run.cleanupCalls).toBe(0);
  });

  it("cleans an ordinary-only latency failure despite keep", async () => {
    const run = await runMatrix({
      ordinaryOnly: true,
      slowCase: 20,
      slowMs: 10000,
    });
    expect(run.results).toHaveLength(21);
    expect(run.results[20]).toMatchObject({
      p95Ms: 10000,
      passed: false,
      matrixKind: "ordinary-baseline",
    });
    expect(run.exitCode).toBe(1);
    expect(run.receipt.passed).toBe(false);
    expect(run.cleanupCalls).toBe(1);
  });

  it("rejects ordinary-only with the ambiguous legacy before mode ahead of hosted setup", async () => {
    const run = await runMatrix({ ordinaryOnly: true, before: true });
    expect(run.exitCode).toBe(1);
    expect(run.setupCalls).toBe(0);
    expect(run.receipt).toBeUndefined();
  });

  it("uses raw p95 instead of rounded display values at the strict threshold", async () => {
    const run = await runMatrix({ slowCase: 56, slowMs: 9999.999 });
    expect(run.results[56]).toMatchObject({
      p95Ms: 9999.999,
      maxMs: 10000,
      passed: true,
    });
    expect(run.exitCode).toBe(0);
  });

  it("accepts exactly twice representative volume", async () => {
    const run = await runMatrix({ representativeBids: "12500" });
    expect(run.exitCode).toBe(0);
    expect(run.receipt).toMatchObject({
      representativeBids: 12500,
      fixtureVolumeMultiple: 2,
    });
  });

  it.each([
    null,
    "",
    "0",
    "-1",
    "1.5",
    "1e4",
    "NaN",
    "Infinity",
    "9007199254740993",
    "12501",
  ])(
    "rejects invalid or under-volume representative count %s before hosted setup",
    async (representativeBids) => {
      const run = await runMatrix({ representativeBids });
      expect(run.exitCode).toBe(1);
      expect(run.setupCalls).toBe(0);
      expect(run.timedReads).toBe(0);
      expect(run.receipt).toBeUndefined();
      expect(run.snapshots).toEqual([]);
    },
  );
});

function queryOracle(fixtureData: unknown) {
  return runInNewContext(
    `${source.slice(source.indexOf("function selected("), source.indexOf("let fixtureData;"))}\n({ expected, validate })`,
    {
      fixtureData,
      assert: Object.assign((value: unknown) => assert(value), assert, {
        deepEqual: (actual: unknown, expected: unknown) =>
          assert.deepEqual(structuredClone(actual), structuredClone(expected)),
      }),
      noMoney: () => {},
    },
  );
}

describe("staging repeat correctness oracle", () => {
  const owner = { id: "owner", role: "client", workspace: "main" };
  const range = { name: "all", from: null, to: null };
  const sort = { id: "screenshot_size_bytes", desc: false };
  const row = (
    id: string,
    applied: boolean,
    pending = false,
    workspace_id = "main",
  ) => ({
    id,
    workspace_id,
    bidder_id: "bidder",
    company: "synthetic " + id,
    evidence_file_id: id + "-file",
    found_at: "2026-10-12T12:00:00Z",
    applied,
    review_status: pending ? "pending" : "approved",
    deleted_at: null,
    arrangement: id === "B" ? "onsite" : "remote",
  });
  const fixtureData = {
    finalBids: [
      row("A", true),
      row("B", false),
      row("C", true),
      row("D", true, true),
      row("E", false, true),
      row("F", false, true),
      row("G", false),
      row("H", false),
      row("I", false, false, "foreign"),
    ],
    bytes: new Map<string, number | null>([
      ["A", 10240],
      ["B", 10240],
      ["C", 10241],
      ["D", 10241],
      ["E", 4096],
      ["F", 4096],
      ["G", 999],
      ["H", null],
      ["I", 10240],
    ]),
  };

  it("derives exact-byte repeated members and independent status counts from the full authorized base", () => {
    const oracle = queryOracle(fixtureData);
    const expected = oracle.expected(
      fixtureData,
      owner,
      range,
      sort,
      null,
      "synthetic",
      { repeated: true },
    );
    expect(expected.rows.map((r: { id: string }) => r.id)).toEqual([
      "E",
      "F",
      "A",
      "B",
      "C",
      "D",
    ]);
    expect(expected.statusCounts).toEqual({
      all: 6,
      applied: 2,
      unapplied: 2,
      pending_review: 2,
    });
    expect(expected.counts.get(10240)).toBe(2);
    expect(expected.counts.get(10241)).toBe(2);
    const applied = oracle.expected(
      fixtureData,
      owner,
      range,
      sort,
      null,
      "synthetic",
      { repeated: true, status: "applied" },
    );
    expect(applied.rows.map((r: { id: string }) => r.id)).toEqual(["C", "D"]);
    expect(applied.counts.get(10240)).toBe(1);
    expect(applied.counts.get(10241)).toBe(2);
    expect(applied.statusCounts).toEqual({
      all: 6,
      applied: 2,
      unapplied: 2,
      pending_review: 2,
    });
    const pending = oracle.expected(
      fixtureData,
      owner,
      range,
      sort,
      null,
      "synthetic",
      { repeated: true, status: "pending_review" },
    );
    expect(pending.rows.map((r: { id: string }) => r.id)).toEqual(["E", "F"]);
  });

  it("keeps ordinary status baselines and normalizes bidder repeated requests to All", () => {
    const oracle = queryOracle(fixtureData);
    const applied = oracle.expected(
      fixtureData,
      owner,
      range,
      sort,
      null,
      "synthetic",
      { status: "applied" },
    );
    expect(applied.rows.map((r: { id: string }) => r.id)).toEqual([
      "A",
      "C",
      "D",
    ]);
    expect(applied.statusCounts).toEqual({
      all: 8,
      applied: 3,
      unapplied: 5,
      pending_review: 3,
    });
    const bidder = { ...owner, role: "bidder", id: "bidder" };
    const forbidden = oracle.expected(
      fixtureData,
      bidder,
      range,
      sort,
      null,
      "synthetic",
      { repeated: true },
    );
    expect(forbidden.rows.map((r: { id: string }) => r.id)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
    ]);
    expect(forbidden.statusCounts).toEqual({
      all: 9,
      applied: 3,
      unapplied: 6,
      pending_review: 3,
    });
  });

  it("applies other filters before building repeated eligibility", () => {
    const oracle = queryOracle(fixtureData);
    const value = oracle.expected(
      fixtureData,
      owner,
      range,
      sort,
      null,
      "synthetic",
      { repeated: true, arrangement: "remote" },
    );
    expect(value.rows.map((r: { id: string }) => r.id)).toEqual([
      "E",
      "F",
      "C",
      "D",
    ]);
    expect(value.statusCounts).toEqual({
      all: 4,
      applied: 2,
      unapplied: 2,
      pending_review: 2,
    });
  });

  it("rejects an RPC snapshot with wrong independent status counts", () => {
    const oracle = queryOracle(fixtureData);
    const expected = oracle.expected(
      fixtureData,
      owner,
      range,
      sort,
      null,
      "synthetic",
      { repeated: true },
    );
    const data = {
      total: 6,
      statusCounts: { all: 6, applied: 3, unapplied: 3, pending_review: 2 },
      rows: [
        {
          id: "E",
          workspace_id: "main",
          screenshot_size_bytes: 4096,
          screenshot_size_match_count: 2,
        },
      ],
    };
    expect(() => oracle.validate(data, expected, owner, 0, 1, true)).toThrow();
    data.statusCounts = { all: 6, applied: 2, unapplied: 2, pending_review: 2 };
    expect(() =>
      oracle.validate(data, expected, owner, 0, 1, true),
    ).not.toThrow();
  });

  it("seeds mixed-status finalized repeats and a nonadditive applied/unapplied pair", () => {
    const fixture = runInNewContext(
      `${source.slice(source.indexOf("const shift ="), source.indexOf("function selected("))}\nfixture`,
      { randomUUID },
    );
    const value = fixture(
      {
        owner,
        admin: { workspace: "foreign" },
        bidder1: { id: "bidder1" },
        bidder2: { id: "bidder2" },
        outsider: { id: "outsider" },
      },
      "synthetic",
      "2026-10-12",
      64,
    );
    expect(
      [6, 22, 38, 54].map((index) => ({
        applied: value.finalBids[index].applied,
        review_status: value.finalBids[index].review_status,
      })),
    ).toEqual([
      { applied: true, review_status: "approved" },
      { applied: true, review_status: "approved" },
      { applied: false, review_status: "approved" },
      { applied: false, review_status: "pending" },
    ]);
    expect(
      [5, 21].map((index) => value.bytes.get(value.finalBids[index].id)),
    ).toEqual([100005, 100005]);
    expect([5, 21].map((index) => value.finalBids[index].applied)).toEqual([
      true,
      false,
    ]);
    expect(
      value.bids.every(
        (r: { review_status: string }) => r.review_status === "approved",
      ),
    ).toBe(true);
  });
});
