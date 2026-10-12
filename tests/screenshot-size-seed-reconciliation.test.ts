import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";
import { seedChunk } from "../scripts/screenshot-size-seed-reconciliation.mjs";

const staging = "https://kdmvludtvhuuewmhurpw.supabase.co";
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const workspace = id(9001);
const bidder = id(9002);
const marker = "screenshot-size-bench-00000000-0000-4000-8000-000000009000";
type Row = Record<string, unknown>;
type Receipt = {
  target: string;
  started: boolean;
  phase: string;
  marker: string;
  fixtureBids: number;
  workspaceIds: string[];
  accounts: { id: string }[];
  seedReconciliationCounts?: unknown;
};
type RequestRecord = {
  method: string;
  path: string;
  rows?: Row[];
  ids?: string[];
  workspaces?: string[];
  projection?: string;
  onConflict?: string | null;
};

function bidRows(count = 500): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: id(i + 1),
    workspace_id: workspace,
    bidder_id: bidder,
    resume_id: id(9003),
    company: `${marker}-main-${i}`,
    role_name: "Synthetic engineer",
    url: `https://benchmark.invalid/${marker}/${i}`,
    normalized_url: `https://benchmark.invalid/${marker}/${i}`,
    source: "synthetic",
    arrangement: "remote",
    found_at: "2026-10-12T18:00:00Z",
    review_status: "approved",
    review_revision: 1,
    applied: true,
    application_method: "manual",
    rate_cents: 100,
    applied_at: "2026-10-12T18:00:00Z",
    first_applied_at: "2026-10-12T18:00:00Z",
    evidence_file_id: null,
    deleted_at: null,
  }));
}

function fileRows(): Row[] {
  return [
    {
      id: id(1),
      workspace_id: workspace,
      bidder_id: bidder,
      bid_id: id(2),
      kind: "screenshot",
      filename: "synthetic.png",
      mime: "image/png",
      size_bytes: 102400,
      storage_path: `${marker}/planned.png`,
      sha256: "a".repeat(64),
      finalized: true,
      created_by: bidder,
      review_revision: 1,
    },
  ];
}

function checked(result: { error?: { code?: string } | null; data?: unknown }) {
  if (result.error)
    throw Object.assign(
      new Error("Hosted operation failed (details withheld)"),
      { code: result.error.code },
    );
  return result.data;
}

function harness({
  rows = bidRows(),
  table = "bids",
  operation = "insert",
  transportLoss = true,
  committed = rows.length,
  writeError = false,
  readError = false,
  adjust = (actual: Row[]) => actual,
}: {
  rows?: Row[];
  table?: string;
  operation?: string;
  transportLoss?: boolean;
  committed?: number;
  writeError?: boolean;
  readError?: boolean;
  adjust?: (actual: Row[]) => Row[];
} = {}) {
  const requests: RequestRecord[] = [];
  const stored = new Map<string, Row>();
  const saves: unknown[] = [];
  const receipt = {
    target: staging,
    started: true,
    phase: "seed",
    marker,
    fixtureBids: 25000,
    workspaceIds: [workspace],
    accounts: [{ id: bidder }],
  } as Receipt;
  const stubFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const payload = JSON.parse(String(init?.body)) as Row[];
      requests.push({
        method,
        path: url.pathname,
        rows: payload,
        onConflict: url.searchParams.get("on_conflict"),
      });
      if (writeError)
        return new Response(
          JSON.stringify({ code: "23505", message: "fixture conflict" }),
          { status: 409 },
        );
      payload
        .slice(0, committed)
        .forEach((row) => stored.set(String(row.id), { ...row }));
      if (transportLoss)
        throw new DOMException(
          "stub transport acknowledgement lost",
          "TimeoutError",
        );
      return new Response(null, { status: 201 });
    }
    if (method !== "GET") throw new Error("Unexpected fixture method");
    const list = (key: string) =>
      (url.searchParams.get(key) ?? "").slice(4, -1).split(",");
    const ids = list("id"),
      workspaces = list("workspace_id");
    requests.push({
      method,
      path: url.pathname,
      ids,
      workspaces,
      projection: url.searchParams.get("select") ?? "",
    });
    if (readError)
      return new Response(
        JSON.stringify({ code: "42501", message: "fixture read denied" }),
        { status: 403 },
      );
    const actual = ids
      .flatMap((key) => {
        const row = stored.get(key);
        return row && workspaces.includes(String(row.workspace_id))
          ? [{ ...row }]
          : [];
      })
      .reverse();
    return new Response(JSON.stringify(adjust(actual)), { status: 200 });
  };
  const service = createClient(staging, "stub-only-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: stubFetch },
  });
  const run = () =>
    seedChunk({
      service,
      receipt,
      table,
      operation,
      rows,
      check: checked,
      save: async () => {
        saves.push(structuredClone(receipt.seedReconciliationCounts));
      },
    });
  return { run, receipt, requests, saves, stored };
}

it("continues after a lost acknowledgement only when all 500 committed seed rows match", async () => {
  const h = harness();
  await h.run();
  expect(h.stored.size).toBe(500);
  expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  const reads = h.requests.filter((r) => r.method === "GET");
  expect(reads).toHaveLength(5);
  expect(
    reads.every(
      (r) => r.ids?.length === 100 && r.workspaces?.join() === workspace,
    ),
  ).toBe(true);
  expect(reads.flatMap((r) => r.ids)).toEqual(bidRows().map((row) => row.id));
  expect(reads[0].projection?.split(",").sort()).toEqual(
    Object.keys(bidRows()[0]).sort(),
  );
  expect(h.receipt.seedReconciliationCounts).toEqual({
    bidsInsert: { attemptedChunks: 1, verifiedChunks: 1, verifiedRows: 500 },
  });
  expect(h.saves).toHaveLength(2);
  expect(JSON.stringify(h.receipt.seedReconciliationCounts)).not.toMatch(
    /workspace|company|rate_cents|00000000/,
  );
});

it("does not add reads or reconciliation counts after a normal successful write", async () => {
  const h = harness({ transportLoss: false });
  await h.run();
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0].rows).toEqual(bidRows());
  expect(h.receipt.seedReconciliationCounts).toBeUndefined();
  expect(h.saves).toHaveLength(0);
});

it.each([0, 499])(
  "fails without retry when only %i planned rows committed",
  async (committed) => {
    const h = harness({ committed });
    await expect(h.run()).rejects.toMatchObject({
      code: "SEED_RECONCILIATION_MISMATCH",
    });
    expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  },
);

it("does not reconcile a server-side SQL error", async () => {
  const h = harness({ writeError: true });
  await expect(h.run()).rejects.toMatchObject({ code: "23505" });
  expect(h.requests).toHaveLength(1);
});

it("fails through the existing checked error path when verification reads fail", async () => {
  const h = harness({ readError: true });
  await expect(h.run()).rejects.toMatchObject({ code: "42501" });
  expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(1);
});

it.each([
  "workspace_id",
  "bidder_id",
  "resume_id",
  "company",
  "normalized_url",
  "review_revision",
  "rate_cents",
  "application_method",
  "evidence_file_id",
  "deleted_at",
])("rejects a changed supplied %s value", async (field) => {
  const h = harness({
    rows: bidRows(1),
    adjust: (actual) => actual.map((row) => ({ ...row, [field]: "changed" })),
  });
  await expect(h.run()).rejects.toMatchObject({
    code: "SEED_RECONCILIATION_MISMATCH",
  });
});

it.each(["duplicate", "unplanned", "missing-field"])(
  "rejects %s rows from the verifier",
  async (bad) => {
    const h = harness({
      rows: bidRows(1),
      adjust: (actual) => {
        if (bad === "duplicate") return [...actual, ...actual];
        if (bad === "unplanned") return [{ ...actual[0], id: id(7000) }];
        const row = { ...actual[0] };
        delete row.evidence_file_id;
        return [row];
      },
    });
    await expect(h.run()).rejects.toMatchObject({
      code: "SEED_RECONCILIATION_MISMATCH",
    });
  },
);

it("accepts only equivalent zero-fraction UTC formatting for supplied timestamps", async () => {
  const h = harness({
    rows: bidRows(1),
    adjust: (actual) =>
      actual.map((row) => ({
        ...row,
        found_at: "2026-10-12T18:00:00.000000+00:00",
        applied_at: "2026-10-12T18:00:00+00:00",
        first_applied_at: "2026-10-12T18:00:00.0Z",
      })),
  });
  await h.run();
  expect(h.receipt.seedReconciliationCounts).toEqual({
    bidsInsert: { attemptedChunks: 1, verifiedChunks: 1, verifiedRows: 1 },
  });
});

it("rejects numeric strings instead of coercing supplied financial values", async () => {
  const h = harness({
    rows: bidRows(1),
    adjust: (actual) => actual.map((row) => ({ ...row, rate_cents: "100" })),
  });
  await expect(h.run()).rejects.toMatchObject({
    code: "SEED_RECONCILIATION_MISMATCH",
  });
});

it.each([
  "2026-10-12T18:00:00.000001+00:00",
  "2026-10-12T13:00:00-05:00",
  "2026-10-12T18:00:01Z",
])(
  "rejects timestamp differences or non-UTC formatting: %s",
  async (found_at) => {
    const h = harness({
      rows: bidRows(1),
      adjust: (actual) => actual.map((row) => ({ ...row, found_at })),
    });
    await expect(h.run()).rejects.toMatchObject({
      code: "SEED_RECONCILIATION_MISMATCH",
    });
  },
);

it.each([
  "size_bytes",
  "finalized",
  "bid_id",
  "storage_path",
  "sha256",
  "created_by",
])("verifies supplied file %s after a lost acknowledgement", async (field) => {
  const h = harness({
    rows: fileRows(),
    table: "files",
    adjust: (actual) => actual.map((row) => ({ ...row, [field]: "changed" })),
  });
  await expect(h.run()).rejects.toMatchObject({
    code: "SEED_RECONCILIATION_MISMATCH",
  });
});

it("reconciles file inserts and final bid upserts without resending either payload", async () => {
  const files = harness({ rows: fileRows(), table: "files" });
  await files.run();
  expect(files.receipt.seedReconciliationCounts).toEqual({
    filesInsert: { attemptedChunks: 1, verifiedChunks: 1, verifiedRows: 1 },
  });
  const rows = bidRows(1).map((row) => ({
    ...row,
    evidence_file_id: id(8000),
    application_method: "screenshot",
  }));
  const bids = harness({ rows, operation: "upsert" });
  await bids.run();
  expect(bids.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  expect(bids.requests[0].rows).toEqual(rows);
  expect(bids.requests[0].onConflict).toBe("id");
  expect(bids.receipt.seedReconciliationCounts).toEqual({
    bidsUpsert: { attemptedChunks: 1, verifiedChunks: 1, verifiedRows: 1 },
  });
});

it("rejects an out-of-receipt workspace before issuing any write", async () => {
  const h = harness({
    rows: bidRows(1).map((row) => ({ ...row, workspace_id: id(9999) })),
  });
  await expect(h.run()).rejects.toBeDefined();
  expect(h.requests).toHaveLength(0);
});
