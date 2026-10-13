// Import-only production acceptance helper. Controller supplies two isolated
// existing-account access tokens in memory; this module never loads env files,
// generates/refreshes/revokes sessions, writes customer data, or logs payloads.
// After rollout: await runPrivateReviewReadOnlySmoke({ productionReadOnly: true,
// target: PRODUCTION_URL, publishableKey, managerAccessToken, bidderAccessToken }).
// Print only its returned check/timing/coverage summary. Controller owns session
// creation and local-session revocation under the existing authorized pattern.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";

export const PRODUCTION_URL = "https://aizorlyfggwbewetnwqm.supabase.co";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["all", "applied", "unapplied", "pending_review"];
const MAX_ROWS = 25000;
const SAFE_COLUMNS = {
  bids: [
    "id",
    "workspace_id",
    "bidder_id",
    "evidence_file_id",
    "found_at",
    "applied",
    "review_status",
    "deleted_at",
  ],
  files: [
    "id",
    "bid_id",
    "workspace_id",
    "bidder_id",
    "kind",
    "finalized",
    "size_bytes",
  ],
  profiles: ["id", "role", "archived", "approval_status"],
  bidders: ["user_id", "workspace_id", "archived"],
  screenshot_upload_contexts: ["id"],
};
const RPC_PARAMS = {
  list_bids_v2: ["p_query"],
  notification_page: ["p_kind", "p_workspace", "p_status", "p_cursor"],
  notification_by_id: ["p_id"],
  notification_unread_count: [],
  manager_screenshot_upload_context: ["p_file"],
  manager_screenshot_upload_history: ["p_bid"],
};
const safeKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
function validListQuery(query) {
  return (
    safeKeys(query, [
      "scopeBidderId",
      "pageSize",
      "pageIndex",
      "status",
      "sorting",
      "columnFilters",
    ]) &&
    UUID.test(query.scopeBidderId ?? "") &&
    Number.isInteger(query.pageSize) &&
    query.pageSize >= 1 &&
    query.pageSize <= 100 &&
    Number.isInteger(query.pageIndex) &&
    query.pageIndex >= 0 &&
    query.pageIndex < MAX_ROWS / 100 &&
    STATUSES.includes(query.status) &&
    Array.isArray(query.sorting) &&
    query.sorting.length === 1 &&
    safeKeys(query.sorting[0], ["id", "desc"]) &&
    ["found_at", "screenshot_size_bytes"].includes(query.sorting[0].id) &&
    typeof query.sorting[0].desc === "boolean" &&
    safeKeys(query.columnFilters, ["screenshot"]) &&
    [undefined, "", "Repeated sizes only"].includes(
      query.columnFilters.screenshot,
    )
  );
}
export function productionReadOnlyFetch(fetchImpl = fetch) {
  return async (input, init = {}) => {
    try {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input));
      assert.equal(url.origin, PRODUCTION_URL);
      assert.ok(!url.username && !url.password && !url.hash);
      assert.equal(
        (init.method ?? request?.method ?? "GET").toUpperCase(),
        "GET",
      );
      assert.ok(!init.body && !request?.body);
      const keys = [...url.searchParams.keys()];
      assert.equal(new Set(keys).size, keys.length);
      if (url.pathname === "/auth/v1/user") assert.equal(keys.length, 0);
      else if (url.pathname.startsWith("/rest/v1/rpc/")) {
        const name = url.pathname.slice("/rest/v1/rpc/".length);
        assert.ok(Object.hasOwn(RPC_PARAMS, name));
        assert.ok(keys.every((key) => RPC_PARAMS[name].includes(key)));
        if (name === "list_bids_v2")
          assert.ok(
            validListQuery(JSON.parse(url.searchParams.get("p_query"))),
          );
        else if (name === "notification_page") {
          assert.ok(
            ["inbox", "messages"].includes(url.searchParams.get("p_kind")),
          );
          assert.ok(!url.searchParams.has("p_cursor"));
          assert.ok(
            !url.searchParams.has("p_status") ||
              url.searchParams.get("p_status") === "all",
          );
          assert.ok(
            !url.searchParams.has("p_workspace") ||
              UUID.test(url.searchParams.get("p_workspace")),
          );
        } else if (name !== "notification_unread_count") {
          assert.equal(keys.length, 1);
          assert.ok(UUID.test(url.searchParams.get(RPC_PARAMS[name][0]) ?? ""));
        }
      } else {
        const table = url.pathname.replace("/rest/v1/", "");
        assert.equal(url.pathname, `/rest/v1/${table}`);
        assert.ok(Object.hasOwn(SAFE_COLUMNS, table));
        const columns = SAFE_COLUMNS[table];
        assert.ok(
          keys.every((key) =>
            ["select", "limit", "offset", "order", ...columns].includes(key),
          ),
        );
        assert.ok(
          (url.searchParams.get("select") ?? "")
            .split(",")
            .every((column) => columns.includes(column)),
        );
        if (url.searchParams.has("limit"))
          assert.ok(
            /^\d+$/.test(url.searchParams.get("limit")) &&
              Number(url.searchParams.get("limit")) <= 1000,
          );
        const headers = new Headers(init.headers ?? request?.headers);
        const range = headers.get("range");
        if (range) {
          const match = /^(\d+)-(\d+)$/.exec(range);
          assert.ok(match && Number(match[2]) - Number(match[1]) < 1000);
        }
      }
    } catch {
      throw new Error("Read-only request rejected");
    }
    const requestSignal =
      init.signal ?? (input instanceof Request ? input.signal : undefined);
    const deadline = AbortSignal.timeout(15000);
    return fetchImpl(input, {
      ...init,
      method: "GET",
      redirect: "error",
      signal: requestSignal
        ? AbortSignal.any([requestSignal, deadline])
        : deadline,
    });
  };
}

const inStatus = (row, status) =>
  status === "all" ||
  (status === "applied"
    ? row.applied
    : status === "unapplied"
      ? !row.applied
      : row.review_status === "pending");
export function repeatedOracle(bids, files, status) {
  assert.ok(STATUSES.includes(status));
  const byId = new Map(files.map((file) => [file.id, file]));
  const evidence = bids.flatMap((bid) => {
    const file = byId.get(bid.evidence_file_id);
    return file?.kind === "screenshot" &&
      file.finalized &&
      file.bid_id === bid.id &&
      file.workspace_id === bid.workspace_id &&
      file.bidder_id === bid.bidder_id &&
      Number.isSafeInteger(file.size_bytes) &&
      file.size_bytes > 0
      ? [{ ...bid, bytes: file.size_bytes }]
      : [];
  });
  const groups = new Map();
  for (const key of STATUSES) {
    const rows = evidence.filter((row) => inStatus(row, key));
    const counts = new Map();
    for (const row of rows)
      counts.set(row.bytes, (counts.get(row.bytes) ?? 0) + 1);
    groups.set(
      key,
      rows
        .filter((row) => counts.get(row.bytes) >= 2)
        .map((row) => ({ ...row, count: counts.get(row.bytes) })),
    );
  }
  return {
    rows: groups
      .get(status)
      .sort(
        (a, b) =>
          b.bytes - a.bytes ||
          Date.parse(b.found_at) - Date.parse(a.found_at) ||
          a.id.localeCompare(b.id),
      ),
    statusCounts: Object.fromEntries(
      STATUSES.map((key) => [key, groups.get(key).length]),
    ),
    evidence,
  };
}
function ok(result) {
  assert.ok(!result.error);
  return result.data;
}
function denied(result) {
  assert.ok(
    result.error &&
      (result.error.code === "42501" ||
        /Access denied|Notification not found/i.test(
          result.error.message ?? "",
        )),
  );
}
function noPrivate(value, bidder = false) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(
      !/^(ip|city|region|country|uploaderId|uploaderRole|uploaderName|originalFileId|upload_context|screenshot_upload_context)$/i.test(
        key,
      ),
    );
    assert.ok(
      !/financial|cents|earnings|rate_override|default_rate/i.test(key),
    );
    if (bidder) assert.ok(!/^screenshot_size_(bytes|match_count)$/.test(key));
    noPrivate(nested, bidder);
  }
}
async function allBids(client, bidderId) {
  const rows = [];
  for (let offset = 0; offset < MAX_ROWS; offset += 1000) {
    const page = ok(
      await client
        .from("bids")
        .select(
          "id,workspace_id,bidder_id,evidence_file_id,found_at,applied,review_status",
        )
        .eq("bidder_id", bidderId)
        .is("deleted_at", null)
        .order("id")
        .range(offset, offset + 999),
    );
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
  // Refuse an incomplete oracle even if the boundary happens to be exactly full.
  throw new Error("Read-only source exceeds bounded smoke scope");
}
const query = (
  bidderId,
  status,
  repeated,
  pageIndex = 0,
  sort = "screenshot_size_bytes",
) => ({
  scopeBidderId: bidderId,
  status,
  pageSize: 100,
  pageIndex,
  sorting: [{ id: sort, desc: true }],
  columnFilters: repeated ? { screenshot: "Repeated sizes only" } : {},
});

export async function runPrivateReviewReadOnlySmoke(config, fetchImpl = fetch) {
  assert.ok(
    config?.productionReadOnly === true && config.target === PRODUCTION_URL,
    "Requires explicit exact production read-only target",
  );
  for (const key of [
    "publishableKey",
    "managerAccessToken",
    "bidderAccessToken",
  ])
    assert.ok(
      typeof config[key] === "string" && config[key].trim(),
      "Missing in-memory smoke credentials",
    );
  assert.ok(
    config.managerAccessToken !== config.bidderAccessToken,
    "Requires distinct existing-account sessions",
  );
  const runDeadline = AbortSignal.timeout(120000);
  const transport = productionReadOnlyFetch((input, init) =>
    fetchImpl(input, {
      ...init,
      signal: AbortSignal.any([init.signal, runDeadline]),
    }),
  );
  const client = (token) =>
    createClient(PRODUCTION_URL, config.publishableKey, {
      db: { retry: false },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: transport,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
    });
  const manager = client(config.managerAccessToken),
    bidder = client(config.bidderAccessToken),
    anonymous = client();
  const results = [];
  const coverage = {
    repeatedRowsObserved: false,
    privateContextObserved: false,
    privateHistoryObserved: false,
    notificationByIdObserved: false,
  };
  const check = async (name, operation) => {
    const start = performance.now();
    try {
      await operation();
    } catch {
      throw new Error(`Read-only smoke failed: ${name}`);
    }
    results.push({
      check: name,
      passed: true,
      durationMs: Math.round(performance.now() - start),
    });
  };
  let managerId, bidderId, bids, files, sample;
  await check("existing-account-scope", async () => {
    managerId = ok(await manager.auth.getUser(config.managerAccessToken)).user
      .id;
    bidderId = ok(await bidder.auth.getUser(config.bidderAccessToken)).user.id;
    assert.notEqual(managerId, bidderId);
    const mp = ok(
      await manager
        .from("profiles")
        .select("id,role,archived,approval_status")
        .eq("id", managerId)
        .single(),
    );
    const bp = ok(
      await bidder
        .from("profiles")
        .select("id,role,archived,approval_status")
        .eq("id", bidderId)
        .single(),
    );
    assert.ok(
      ["client", "admin"].includes(mp.role) &&
        !mp.archived &&
        mp.approval_status === "approved",
    );
    assert.ok(bp.role === "bidder" && !bp.archived);
    bids = await allBids(manager, bidderId);
    assert.ok(bids.length);
    const ids = [
      ...new Set(bids.map((row) => row.evidence_file_id).filter(Boolean)),
    ];
    files = [];
    for (let offset = 0; offset < ids.length; offset += 100)
      files.push(
        ...ok(
          await manager
            .from("files")
            .select(
              "id,bid_id,workspace_id,bidder_id,kind,finalized,size_bytes",
            )
            .in("id", ids.slice(offset, offset + 100)),
        ),
      );
    const evidence = repeatedOracle(bids, files, "all").evidence;
    sample = evidence[0] ?? bids[0];
    const membership = ok(
      await manager
        .from("bidders")
        .select("user_id,workspace_id,archived")
        .eq("user_id", bidderId)
        .eq("workspace_id", sample.workspace_id)
        .single(),
    );
    assert.ok(!membership.archived);
  });
  for (const status of STATUSES)
    await check(`manager-repeated:${status}`, async () => {
      const expected = repeatedOracle(bids, files, status);
      coverage.repeatedRowsObserved ||= expected.rows.length > 0;
      const last = Math.max(0, Math.ceil(expected.rows.length / 100) - 1);
      for (const pageIndex of new Set([0, last])) {
        // The installed SDK interpolates GET argument objects as [object Object].
        // Supply the jsonb parameter as JSON text to preserve a real GET request.
        const data = ok(
          await manager.rpc(
            "list_bids_v2",
            {
              p_query: JSON.stringify(query(bidderId, status, true, pageIndex)),
            },
            { get: true },
          ),
        );
        assert.equal(data.total, expected.rows.length);
        assert.deepEqual(data.statusCounts, expected.statusCounts);
        const page = expected.rows.slice(
          pageIndex * 100,
          (pageIndex + 1) * 100,
        );
        assert.deepEqual(
          data.rows.map((row) => row.id),
          page.map((row) => row.id),
        );
        for (let index = 0; index < page.length; index++) {
          assert.equal(
            data.rows[index].screenshot_size_bytes,
            page[index].bytes,
          );
          assert.equal(
            data.rows[index].screenshot_size_match_count,
            page[index].count,
          );
        }
        noPrivate(data.rows);
      }
    });
  for (const status of STATUSES)
    await check(`bidder-filter-sort-fallback:${status}`, async () => {
      const ordinary = ok(
        await bidder.rpc(
          "list_bids_v2",
          {
            p_query: JSON.stringify(
              query(bidderId, status, false, 0, "found_at"),
            ),
          },
          { get: true },
        ),
      );
      const fallback = ok(
        await bidder.rpc(
          "list_bids_v2",
          { p_query: JSON.stringify(query(bidderId, status, true)) },
          { get: true },
        ),
      );
      assert.equal(fallback.total, ordinary.total);
      assert.deepEqual(fallback.statusCounts, ordinary.statusCounts);
      assert.deepEqual(
        fallback.rows.map((row) => row.id),
        ordinary.rows.map((row) => row.id),
      );
      noPrivate(ordinary.rows, true);
      noPrivate(fallback.rows, true);
    });
  await check("notification-read-permissions", async () => {
    const messages = ok(
      await manager.rpc(
        "notification_page",
        { p_kind: "messages", p_workspace: sample.workspace_id },
        { get: true },
      ),
    );
    assert.ok(Array.isArray(messages.rows) && messages.rows.length <= 50);
    assert.ok(
      messages.rows.every((row) => row.workspace_id === sample.workspace_id),
    );
    denied(
      await bidder.rpc(
        "notification_page",
        { p_kind: "messages", p_workspace: sample.workspace_id },
        { get: true },
      ),
    );
    const inbox = ok(
      await bidder.rpc("notification_page", { p_kind: "inbox" }, { get: true }),
    );
    assert.ok(Array.isArray(inbox.rows) && inbox.rows.length <= 50);
    assert.ok(
      inbox.rows.every(
        (row) => row.user_id === bidderId && row.kind === "message",
      ),
    );
    for (const current of [manager, bidder])
      assert.ok(
        Number.isSafeInteger(
          Number(
            ok(
              await current.rpc("notification_unread_count", {}, { get: true }),
            ),
          ),
        ),
      );
    if (inbox.rows.length) {
      const row = ok(
        await bidder.rpc(
          "notification_by_id",
          { p_id: inbox.rows[0].id },
          { get: true },
        ),
      );
      assert.equal(row.user_id, bidderId);
      denied(
        await manager.rpc(
          "notification_by_id",
          { p_id: inbox.rows[0].id },
          { get: true },
        ),
      );
      coverage.notificationByIdObserved = true;
    }
    denied(
      await anonymous.rpc(
        "notification_page",
        { p_kind: "inbox" },
        { get: true },
      ),
    );
  });
  await check("private-context-read-permissions", async () => {
    const history = ok(
      await manager.rpc(
        "manager_screenshot_upload_history",
        { p_bid: sample.id },
        { get: true },
      ),
    );
    assert.ok(Array.isArray(history.items) && history.items.length <= 50);
    assert.ok(
      history.items.every(
        (item) => item.bidId === sample.id && item.bidderId === bidderId,
      ),
    );
    coverage.privateHistoryObserved = history.items.length > 0;
    for (const current of [bidder, anonymous])
      denied(
        await current.rpc(
          "manager_screenshot_upload_history",
          { p_bid: sample.id },
          { get: true },
        ),
      );
    const evidence = repeatedOracle(bids, files, "all").evidence;
    if (evidence.length) {
      const context = ok(
        await manager.rpc(
          "manager_screenshot_upload_context",
          { p_file: sample.evidence_file_id },
          { get: true },
        ),
      );
      if (context !== null) {
        assert.equal(context.bidId, sample.id);
        assert.equal(context.originalFileId, sample.evidence_file_id);
        coverage.privateContextObserved = true;
      }
      for (const current of [bidder, anonymous])
        denied(
          await current.rpc(
            "manager_screenshot_upload_context",
            { p_file: sample.evidence_file_id },
            { get: true },
          ),
        );
    }
    for (const current of [manager, bidder, anonymous]) {
      const table = await current
        .from("screenshot_upload_contexts")
        .select("id")
        .limit(1);
      assert.equal(table.error?.code, "42501");
    }
  });
  return { passed: true, readOnly: true, checks: results, coverage };
}
