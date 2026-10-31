import { expect, it, vi } from "vitest";
import {
  PRODUCTION_URL,
  productionReadOnlyFetch,
  repeatedOracle,
  runPrivateReviewReadOnlySmoke,
} from "../scripts/private-review-production-smoke.mjs";

const bid = "70000000-0000-4000-8000-000000000001";
const file = "70000000-0000-4000-8000-000000000002";
const actor = "70000000-0000-4000-8000-000000000003";
const workspace = "70000000-0000-4000-8000-000000000004";
const reads = [
  "/auth/v1/user",
  "/rest/v1/bids?select=id&limit=1",
  `/rest/v1/rpc/list_bids_v2?p_query=${encodeURIComponent(JSON.stringify({ scopeBidderId: actor, pageSize: 100, pageIndex: 0, status: "all", columnFilters: { screenshot: "Repeated sizes only" }, sorting: [{ id: "screenshot_size_bytes", desc: true }] }))}`,
];
it("allows only exact production read endpoints and forces failed redirects", async () => {
  const transport = vi.fn(async () => new Response("{}"));
  const guarded = productionReadOnlyFetch(transport);
  for (const route of reads) await guarded(`${PRODUCTION_URL}${route}`);
  expect(transport).toHaveBeenCalledTimes(reads.length);
  for (const [, options] of transport.mock.calls as unknown as [
    string,
    RequestInit,
  ][]) {
    expect(options.method).toBe("GET");
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  }
});
it.each([
  ["https://production.invalid/rest/v1/bids", {}],
  [`${PRODUCTION_URL}/rest/v1/bids`, { method: "POST" }],
  [`${PRODUCTION_URL}/rest/v1/bids`, { method: "DELETE" }],
  [`${PRODUCTION_URL}/auth/v1/token`, {}],
  [`${PRODUCTION_URL}/auth/v1/admin/users`, {}],
  [`${PRODUCTION_URL}/rest/v1/rpc/process_due_messages`, {}],
  [`${PRODUCTION_URL}/rest/v1/rpc/finalize_verified_file_v2`, {}],
  [`${PRODUCTION_URL}/rest/v1/rpc/save_notification_message`, {}],
  [
    `${PRODUCTION_URL}/rest/v1/rpc/notification_page?p_kind=messages&p_cursor=%7B%7D`,
    {},
  ],
  [`${PRODUCTION_URL}/rest/v1/rpc/notification_page?p_kind=bad`, {}],
  [
    `${PRODUCTION_URL}/rest/v1/rpc/manager_screenshot_upload_context?p_file=${file}&p_actor=${actor}`,
    {},
  ],
  [
    `${PRODUCTION_URL}/rest/v1/rpc/list_bids_v2?p_query=${encodeURIComponent(JSON.stringify({ pageSize: 1000 }))}`,
    {},
  ],
  [
    `${PRODUCTION_URL}/rest/v1/rpc/list_bids_v2?p_query=${encodeURIComponent(JSON.stringify({ columnFilters: { company: "private" } }))}`,
    {},
  ],
])(
  "rejects unsupported targets, mutations and expanded RPC scope before network access",
  async (url, options) => {
    const transport = vi.fn(async () => new Response("{}"));
    await expect(
      productionReadOnlyFetch(transport)(url, options),
    ).rejects.toThrow("Read-only request rejected");
    expect(transport).not.toHaveBeenCalled();
  },
);
it("enforces Request methods and rejects credentials, duplicate parameters and request bodies", async () => {
  const guarded = productionReadOnlyFetch(vi.fn());
  for (const request of [
    new Request(`${PRODUCTION_URL}/rest/v1/bids`, {
      method: "PATCH",
      body: "{}",
    }),
    `${PRODUCTION_URL.replace("https://", "https://secret@")}/rest/v1/bids`,
    `${PRODUCTION_URL}/rest/v1/rpc/notification_page?p_kind=inbox&p_kind=messages`,
  ])
    await expect(guarded(request)).rejects.toThrow();
  await expect(
    guarded(`${PRODUCTION_URL}/rest/v1/bids`, { body: "{}" }),
  ).rejects.toThrow();
});

it("derives each repeated status group independently and excludes invalid evidence", () => {
  const bids = [
    {
      id: "a",
      workspace_id: workspace,
      bidder_id: actor,
      evidence_file_id: "fa",
      found_at: "2026-10-12T10:00:00Z",
      applied: true,
      review_status: "approved",
    },
    {
      id: "b",
      workspace_id: workspace,
      bidder_id: actor,
      evidence_file_id: "fb",
      found_at: "2026-10-12T11:00:00Z",
      applied: false,
      review_status: "pending",
    },
    {
      id: "c",
      workspace_id: workspace,
      bidder_id: actor,
      evidence_file_id: "fc",
      found_at: "2026-10-12T12:00:00Z",
      applied: false,
      review_status: "pending",
    },
    {
      id: "d",
      workspace_id: workspace,
      bidder_id: actor,
      evidence_file_id: "fd",
      found_at: "2026-10-12T13:00:00Z",
      applied: true,
      review_status: "approved",
    },
    {
      id: "e",
      workspace_id: workspace,
      bidder_id: actor,
      evidence_file_id: "fe",
      found_at: "2026-10-12T14:00:00Z",
      applied: true,
      review_status: "approved",
    },
  ];
  const files = bids.map((row) => ({
    id: row.evidence_file_id,
    bid_id: row.id,
    workspace_id: workspace,
    bidder_id: actor,
    kind: "screenshot",
    finalized: true,
    size_bytes: row.id === "d" ? 200 : 100,
  }));
  files[4].bid_id = "foreign";
  const all = repeatedOracle(bids, files, "all");
  expect(all.statusCounts).toEqual({
    all: 3,
    applied: 0,
    unapplied: 2,
    pending_review: 2,
  });
  expect(all.rows.map((row: { id: string }) => row.id)).toEqual([
    "c",
    "b",
    "a",
  ]);
  expect(all.rows.map((row: { count: number }) => row.count)).toEqual([
    3, 3, 3,
  ]);
  const pending = repeatedOracle(bids, files, "pending_review");
  expect(
    pending.rows.map((row: { id: string; count: number }) => [
      row.id,
      row.count,
    ]),
  ).toEqual([
    ["c", 2],
    ["b", 2],
  ]);
  expect(repeatedOracle(bids, files, "applied").rows).toEqual([]);
});

const config = {
  productionReadOnly: true,
  target: PRODUCTION_URL,
  publishableKey: "public-test-key",
  managerAccessToken: "manager-test-token",
  bidderAccessToken: "bidder-test-token",
};
it("refuses missing authorization or a changed target before any network request", async () => {
  const transport = vi.fn();
  for (const change of [
    { productionReadOnly: false },
    { target: "https://staging.invalid" },
    { managerAccessToken: "" },
    { bidderAccessToken: config.managerAccessToken },
  ]) {
    await expect(
      runPrivateReviewReadOnlySmoke({ ...config, ...change }, transport),
    ).rejects.toThrow();
  }
  expect(transport).not.toHaveBeenCalled();
});

function fixtureTransport(fail = false) {
  const managerId = "70000000-0000-4000-8000-000000000005";
  const bids = [
    {
      id: bid,
      workspace_id: workspace,
      bidder_id: actor,
      evidence_file_id: file,
      found_at: "2026-10-12T10:00:00Z",
      applied: true,
      review_status: "approved",
    },
    {
      id: "70000000-0000-4000-8000-000000000006",
      workspace_id: workspace,
      bidder_id: actor,
      evidence_file_id: "70000000-0000-4000-8000-000000000007",
      found_at: "2026-10-12T11:00:00Z",
      applied: false,
      review_status: "pending",
    },
    {
      id: "70000000-0000-4000-8000-000000000008",
      workspace_id: workspace,
      bidder_id: actor,
      evidence_file_id: "70000000-0000-4000-8000-000000000009",
      found_at: "2026-10-12T12:00:00Z",
      applied: false,
      review_status: "pending",
    },
  ];
  const files = bids.map((row) => ({
    id: row.evidence_file_id,
    bid_id: row.id,
    workspace_id: workspace,
    bidder_id: actor,
    kind: "screenshot",
    finalized: true,
    size_bytes: 100,
  }));
  const counts = { all: 3, applied: 1, unapplied: 2, pending_review: 2 };
  const repeatedCounts = {
    all: 3,
    applied: 0,
    unapplied: 2,
    pending_review: 2,
  };
  const privateText = "PRIVATE customer text and location";
  const transport = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const manager =
        new Headers(init.headers).get("Authorization") ===
        `Bearer ${config.managerAccessToken}`;
      const bidder =
        new Headers(init.headers).get("Authorization") ===
        `Bearer ${config.bidderAccessToken}`;
      expect(init.method).toBe("GET");
      const response = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        });
      const deny = (code = "P0001") =>
        response({ code, message: "Access denied" }, 403);
      if (url.pathname === "/auth/v1/user")
        return response({ id: manager ? managerId : actor });
      if (url.pathname === "/rest/v1/profiles")
        return response({
          id: manager ? managerId : actor,
          role: manager ? "client" : "bidder",
          archived: false,
          approval_status: "approved",
        });
      if (url.pathname === "/rest/v1/bids") return response(bids);
      if (url.pathname === "/rest/v1/files") return response(files);
      if (url.pathname === "/rest/v1/bidders")
        return response({
          user_id: actor,
          workspace_id: workspace,
          archived: false,
        });
      if (url.pathname === "/rest/v1/bid_application_locations")
        return deny("42501");
      const name = url.pathname.split("/").at(-1);
      if (name === "list_bids_v2") {
        if (!manager && !bidder) return deny("42501");
        const query = JSON.parse(url.searchParams.get("p_query")!);
        const repeated =
          manager && query.columnFilters.screenshot === "Repeated sizes only";
        const selected = bids.filter(
          (row) =>
            query.status === "all" ||
            (query.status === "applied"
              ? row.applied
              : query.status === "unapplied"
                ? !row.applied
                : row.review_status === "pending"),
        );
        const rows = (
          repeated && query.status === "applied" ? [] : [...selected].reverse()
        ).map((row) =>
          manager
            ? {
                ...row,
                applicationLocation: {ip:privateText,city:null,region:null,country:"US",uploadedAt:"2026-10-31T12:00:00Z",source:"vercel",status:"available"},
                screenshot_size_bytes: fail ? privateText : 100,
                screenshot_size_match_count: selected.length,
              }
            : {...row,applicationLocation:{ip:privateText,city:null,region:null,country:"US",uploadedAt:"2026-10-31T12:00:00Z",source:"vercel",status:"available"}},
        );
        return response({
          rows,
          total: rows.length,
          statusCounts: repeated ? repeatedCounts : counts,
        });
      }
      throw new Error(`Unexpected local fixture route: ${url.pathname}`);
    },
  );
  return { transport, privateText };
}
it("uses real Supabase GET serialization for all checks and returns only nonsensitive coverage", async () => {
  const timeouts = vi.spyOn(AbortSignal, "timeout");
  const { transport, privateText } = fixtureTransport();
  const result = await runPrivateReviewReadOnlySmoke(config, transport);
  const timeoutBudgets = timeouts.mock.calls.map(
    ([milliseconds]) => milliseconds,
  );
  timeouts.mockRestore();
  expect(timeoutBudgets).toContain(120000);
  expect(result).toMatchObject({
    passed: true,
    readOnly: true,
    coverage: {
      repeatedRowsObserved: true,
      applicationLocationObserved: true,
    },
  });
  expect(result.checks).toHaveLength(10);
  expect(JSON.stringify(result)).not.toContain(privateText);
  for (const value of [
    bid,
    file,
    actor,
    workspace,
    config.managerAccessToken,
    config.bidderAccessToken,
  ])
    expect(JSON.stringify(result)).not.toContain(value);
});
it("sanitizes failed assertions instead of exposing customer payloads or raw API errors", async () => {
  const { transport, privateText } = fixtureTransport(true);
  try {
    await runPrivateReviewReadOnlySmoke(config, transport);
    throw new Error("Expected failure");
  } catch (error) {
    expect(String(error)).toBe(
      "Error: Read-only smoke failed: manager-repeated:all",
    );
    expect(String(error)).not.toContain(privateText);
    expect(String(error)).not.toContain(bid);
  }
});
