// Hosted reporting acceptance: read-only customer/application data.
// Explicit auth exception: generate a no-email link for EXISTING accounts,
// verify an isolated session, and revoke only that generated local session.
// node --env-file=.env.local scripts/reporting-production-smoke.mjs --production-read-only
// node --env-file=.env.staging scripts/reporting-production-smoke.mjs --staging-read-only
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { formatInTimeZone } from "date-fns-tz";
import { chromium, expect as baseExpect } from "@playwright/test";

const productionMode = process.argv.includes("--production-read-only");
const stagingMode = process.argv.includes("--staging-read-only");
const checkArrangements = process.argv.includes("--arrangements");
const checkScreenshotSizes = process.argv.includes("--screenshot-sizes");
const expectedUrl = stagingMode
  ? "https://kdmvludtvhuuewmhurpw.supabase.co"
  : "https://aizorlyfggwbewetnwqm.supabase.co";
const origin = stagingMode
  ? "https://bidder-check-staging.vercel.app"
  : "https://bidder-check.vercel.app";
const expect = baseExpect.configure({ timeout: 45000 });
const sessions = [];
const results = [];
let browser;
let step = "configuration";
let assertionStage = "none";
function ok(result) {
  if (result.error) throw result.error;
  return result.data;
}
function validAmount(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}
function noMoney(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(
      !/financial|cents|earnings|rate_override|default_rate|rate_cents/i.test(
        key,
      ),
    );
    noMoney(nested);
  }
}
async function measure(role, check, operation) {
  step = `${role}:${check}`;
  const start = performance.now();
  const value = await operation();
  results.push({
    role,
    check,
    durationMs: Math.round(performance.now() - start),
    passed: true,
  });
  return value;
}
async function chooseActors(service) {
  // Safe scope IDs only. No private names, emails, row IDs, or values are emitted.
  const checked = new Set();
  for (let offset = 0; offset < 20000; offset += 1000) {
    const rows = ok(
      await service
        .from("bids")
        .select("id,workspace_id,bidder_id,resume_id")
        .is("deleted_at", null)
        .lte("found_at", new Date().toISOString())
        .order("id")
        .range(offset, offset + 999),
    );
    for (const row of rows) {
      const pair = `${row.workspace_id}:${row.bidder_id}`;
      if (checked.has(pair)) continue;
      checked.add(pair);
      const workspace = ok(
        await service
          .from("workspaces")
          .select("owner_id")
          .eq("id", row.workspace_id)
          .single(),
      );
      const people = ok(
        await service
          .from("profiles")
          .select("id,role,archived,approval_status")
          .in("id", [workspace.owner_id, row.bidder_id]),
      );
      const manager = people.find(
        (person) =>
          person.id === workspace.owner_id &&
          ["client", "admin"].includes(person.role) &&
          !person.archived &&
          person.approval_status === "approved",
      );
      const bidder = people.find(
        (person) =>
          person.id === row.bidder_id &&
          person.role === "bidder" &&
          !person.archived,
      );
      if (!manager || !bidder) continue;
      const membership = ok(
        await service
          .from("bidders")
          .select("user_id,archived")
          .eq("user_id", bidder.id)
          .eq("workspace_id", row.workspace_id)
          .single(),
      );
      if (!membership.archived) return { manager, bidder, sample: row };
    }
    if (rows.length < 1000) break;
  }
  throw new Error(
    "No eligible existing manager/bidder scope with active applications",
  );
}
async function authenticate(service, actor) {
  const existing = ok(await service.auth.admin.getUserById(actor.id)).user;
  assert.ok(existing.email && !existing.banned_until);
  const generated = ok(
    await service.auth.admin.generateLink({
      type: "magiclink",
      email: existing.email,
    }),
  );
  assert.equal(generated.user.id, actor.id);
  assert.ok(generated.properties.hashed_token);
  const jar = new Map();
  const client = createServerClient(
    expectedUrl,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: { autoRefreshToken: false },
      cookies: {
        getAll: () =>
          [...jar.values()].map(({ name, value }) => ({ name, value })),
        setAll: (cookies) => {
          for (const cookie of cookies) jar.set(cookie.name, cookie);
        },
      },
    },
  );
  const verified = ok(
    await client.auth.verifyOtp({
      token_hash: generated.properties.hashed_token,
      type: "email",
    }),
  );
  assert.equal(verified.user.id, actor.id);
  assert.ok(verified.session && jar.size);
  sessions.push(client);
  return { client, jar };
}
async function reports(role, client, workspace) {
  const today = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  for (const preset of ["this_week", "this_month", "all"]) {
    const range =
      preset === "all"
        ? { p_from: null, p_to: null }
        : {
            p_from: preset === "this_week"
              ? monday.toISOString().slice(0, 10)
              : `${today.slice(0, 7)}-01`,
            p_to: today,
          };
    const params = { ...range, p_workspace: workspace };
    const dashboard = await measure(role, `dashboard:${preset}`, async () => {
      const data = ok(await client.rpc("dashboard_performance_v2", params));
      assert.ok(
        Array.isArray(data.series) &&
          data.series.length > 0 &&
          data.series.length <= 120,
      );
      assert.ok(
        Array.isArray(data.comparisons.bidders) &&
          Array.isArray(data.comparisons.profiles),
      );
      assert.ok(
        Number.isSafeInteger(data.totals.found) && data.totals.found >= 0,
      );
      if (preset === "all") assert.ok(data.totals.found > 0);
      assert.ok(
        data.totals.foundApplied >= 0 &&
          data.totals.foundApplied <= data.totals.found,
      );
      if (checkArrangements) {
        for (const groups of Object.values(data.comparisons)) {
          assert.equal(
            groups.reduce((n, row) => n + row.found, 0),
            data.totals.found,
          );
          assert.equal(
            groups.reduce((n, row) => n + row.foundApplied, 0),
            data.totals.foundApplied,
          );
          for (const row of groups) {
            assert.deepEqual(Object.keys(row.arrangements).sort(), [
              "onsiteHybrid",
              "remote",
              "unspecified",
            ]);
            const buckets = Object.values(row.arrangements);
            for (const bucket of buckets) {
              assert.ok(
                Number.isSafeInteger(bucket.found) && bucket.found >= 0,
              );
              assert.ok(
                Number.isSafeInteger(bucket.foundApplied) &&
                  bucket.foundApplied >= 0 &&
                  bucket.foundApplied <= bucket.found,
              );
            }
            assert.equal(
              buckets.reduce((n, bucket) => n + bucket.found, 0),
              row.found,
            );
            assert.equal(
              buckets.reduce((n, bucket) => n + bucket.foundApplied, 0),
              row.foundApplied,
            );
          }
        }
      }
      if (role === "bidder") noMoney(data);
      else {
        assert.deepEqual(Object.keys(data.financial).sort(), [
          "earningsCents",
          "earningsCount",
        ]);
        assert.ok(Number.isSafeInteger(data.financial.earningsCents));
        assert.ok(Number.isSafeInteger(data.financial.earningsCount));
      }
      return data;
    });
    await measure(role, `interviews:${preset}`, async () => {
      const data = ok(
        await client.rpc("interview_performance", {
          ...params,
          p_group: "bidder",
        }),
      );
      noMoney(data);
      assert.ok(Array.isArray(data.groups));
      assert.ok(
        Number.isSafeInteger(data.totals.applied) && data.totals.applied >= 0,
      );
      assert.ok(
        Number.isSafeInteger(data.totals.interviews) &&
          data.totals.interviews >= 0,
      );
      assert.ok(data.totals.interviews <= data.totals.applied);
    });
    if (role === "manager")
      await measure(role, `earnings:${preset}`, async () => {
        const earnings = ok(
          await client.rpc("earnings_performance_v2", {
            ...params,
            p_group: "bidder",
          }),
        );
        assert.ok(Array.isArray(earnings.groups));
        assert.equal(earnings.totals.cents, dashboard.financial.earningsCents);
        assert.equal(earnings.totals.count, dashboard.financial.earningsCount);
      });
    results.at(-1).seriesBucketCount = dashboard.series.length;
    results.at(-1).applicationCount = dashboard.totals.found;
  }
}
async function boundary(role, client, sample) {
  await measure(role, "column-boundary", async () => {
    for (const [table, column] of [
      ["bidders", "default_rate_cents"],
      ["resumes", "rate_override_cents"],
      ["bids", "rate_cents"],
      ["retained_bid_daily_aggregates", "earned_cents"],
      ["bid_events", "details"],
    ]) {
      const denied = await client.from(table).select(column).limit(1);
      assert.equal(denied.error?.code, "42501");
    }
    const query = {
      scopeBidderId: sample.bidder_id,
      pageSize: 10,
      pageIndex: 0,
    };
    const list = ok(await client.rpc("list_bids_v2", { p_query: query }));
    assert.ok(list.total > 0 && list.rows.length > 0 && list.rows.length <= 10);
    noMoney(list.rows);
    const financeArgs = {
      p_bidder_ids: [sample.bidder_id],
      p_resume_ids: [sample.resume_id],
      p_bid_ids: [sample.id],
    };
    const finance = await client.rpc("manager_financial_values", financeArgs);
    if (role === "manager") {
      const values = ok(finance);
      assert.deepEqual(Object.keys(values).sort(), [
        "bidders",
        "bids",
        "resumes",
      ]);
      for (const [kind, id] of [
        ["bidders", sample.bidder_id],
        ["resumes", sample.resume_id],
        ["bids", sample.id],
      ]) {
        assert.deepEqual(Object.keys(values[kind]), [id]);
        assert.ok(validAmount(values[kind][id]));
      }
    } else {
      assert.match(finance.error?.message ?? "", /Access denied/i);
      for (const name of [
        "earnings_performance_v2",
        "earnings_performance",
        "dashboard_performance",
        "retained_aggregate_summary",
      ]) {
        const args =
          name === "retained_aggregate_summary"
            ? {}
            : { p_from: "2026-10-01", p_to: "2026-10-12" };
        assert.match(
          (await client.rpc(name, args)).error?.message ?? "",
          /Access denied/i,
        );
      }
    }
  });
}
async function screenshotOracle(client) {
  // The authenticated caller's RLS defines the same complete authorized scope
  // as list_bids_v2 and /bids. Safe source projections remain independent of RPC DTOs.
  const source = [];
  for (let offset = 0; offset < 100000; offset += 1000) {
    const rows = ok(
      await client
        .from("bids")
        .select("id,workspace_id,bidder_id,evidence_file_id,found_at")
        .is("deleted_at", null)
        .order("id")
        .range(offset, offset + 999),
    );
    source.push(...rows);
    if (rows.length < 1000) break;
    assert.ok(offset < 99000, "Scoped read exceeds smoke safety limit");
  }
  const fileIds = [
    ...new Set(source.map((row) => row.evidence_file_id).filter(Boolean)),
  ];
  const files = new Map();
  for (let offset = 0; offset < fileIds.length; offset += 100) {
    for (const file of ok(
      await client
        .from("files")
        .select("id,bid_id,workspace_id,bidder_id,kind,finalized,size_bytes")
        .in("id", fileIds.slice(offset, offset + 100)),
    ))
      files.set(file.id, file);
  }
  const bytes = (row) => {
    const file = files.get(row.evidence_file_id);
    return file?.kind === "screenshot" &&
      file.finalized &&
      file.bid_id === row.id &&
      file.workspace_id === row.workspace_id &&
      file.bidder_id === row.bidder_id
      ? file.size_bytes
      : null;
  };
  return { source, bytes };
}
function screenshotUiExpected(oracle, bidderId) {
  const rows = oracle.source.filter(
    (row) => !bidderId || row.bidder_id === bidderId,
  );
  const sizes = rows.map(oracle.bytes).filter((size) => size !== null);
  if (!sizes.length) return null;
  const size = sizes.reduce((largest, value) => Math.max(largest, value), 0);
  return { bytes: size, count: sizes.filter((value) => value === size).length };
}
async function screenshotSizes(role, client, sample, oracle) {
  // No identities, names, bytes, response payloads or credentials are emitted.
  await measure(role, "screenshot-sizes:rpc", async () => {
    const source = oracle.source.filter(
      (row) => row.bidder_id === sample.bidder_id,
    );
    const bytes = oracle.bytes;
    const today = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
    const recent = new Date(`${today}T12:00:00Z`);
    recent.setUTCDate(recent.getUTCDate() - 29);
    for (const range of [
      { name: "all", from: null },
      { name: "recent", from: recent.toISOString() },
    ]) {
      const retained = source.filter(
        (row) =>
          !range.from || Date.parse(row.found_at) >= Date.parse(range.from),
      );
      const counts = new Map();
      for (const row of retained) {
        const size = bytes(row);
        if (size !== null) counts.set(size, (counts.get(size) ?? 0) + 1);
      }
      for (const sort of [
        { id: "found_at", desc: true },
        { id: "screenshot_size_bytes", desc: false },
        { id: "screenshot_size_bytes", desc: true },
      ]) {
        const expected = [...retained].sort((a, b) => {
          let primary;
          if (role === "manager" && sort.id === "screenshot_size_bytes") {
            const sa = bytes(a),
              sb = bytes(b);
            if (sa === null && sb !== null) return 1;
            if (sb === null && sa !== null) return -1;
            primary = sa === null ? 0 : (sa - sb) * (sort.desc ? -1 : 1);
          } else
            primary =
              (Date.parse(a.found_at) - Date.parse(b.found_at)) *
              (sort.desc ? -1 : 1);
          return (
            primary ||
            Date.parse(b.found_at) - Date.parse(a.found_at) ||
            a.id.localeCompare(b.id)
          );
        });
        const last = Math.max(0, Math.ceil(expected.length / 100) - 1);
        for (const pageIndex of [
          ...new Set([0, Math.min(1, last), Math.floor(last / 2), last]),
        ]) {
          assertionStage = `screenshot-rpc:${range.name}:${sort.desc ? "desc" : "asc"}`;
          const data = ok(
            await client.rpc("list_bids_v2", {
              p_query: {
                scopeBidderId: sample.bidder_id,
                rangeFrom: range.from,
                sorting: [sort],
                pageSize: 100,
                pageIndex,
              },
            }),
          );
          assert.equal(data.total, expected.length);
          const page = expected.slice(pageIndex * 100, (pageIndex + 1) * 100);
          assert.deepEqual(
            data.rows.map((row) => row.id),
            page.map((row) => row.id),
          );
          noMoney(data.rows);
          for (let index = 0; index < data.rows.length; index++) {
            const row = data.rows[index],
              size = bytes(page[index]);
            if (role === "bidder") {
              assert.ok(!Object.hasOwn(row, "screenshot_size_bytes"));
              assert.ok(!Object.hasOwn(row, "screenshot_size_match_count"));
            } else {
              assert.equal(row.screenshot_size_bytes, size);
              assert.equal(
                row.screenshot_size_match_count,
                size === null ? 0 : counts.get(size),
              );
            }
          }
        }
      }
    }
    // Missing real duplicate data is legitimate; explicitly record coverage only.
    const available = source.filter((row) => bytes(row) !== null);
    const byteCounts = new Map();
    for (const row of available)
      byteCounts.set(bytes(row), (byteCounts.get(bytes(row)) ?? 0) + 1);
    results.push({
      role,
      check: "screenshot-sizes:data-coverage",
      passed: true,
      metadataAvailable: available.length > 0,
      repeatedSizesAvailable: [...byteCounts.values()].some(
        (count) => count > 1,
      ),
    });
  });
}
function screenshotBidResponse(page, path, preset, sort) {
  const pending = page.waitForResponse((response) => {
    const request = response.request();
    if (
      request.method() !== "POST" ||
      !request.headers()["next-action"] ||
      new URL(request.url()).pathname !== path
    )
      return false;
    try {
      const args = JSON.parse(request.postData() ?? "[]");
      const sorting = args[5]?.sorting?.[0];
      return (
        args[0] === preset &&
        (!sort || (sorting?.id === sort.id && sorting?.desc === sort.desc))
      );
    } catch {
      return false;
    }
  });
  pending.catch(() => {});
  return pending;
}
async function screenshotSizeUi(
  role,
  page,
  sample,
  clean,
  oracle,
  detail = false,
) {
  const path = detail ? `/users/${sample.bidder_id}` : "/bids";
  await measure(
    role,
    detail ? "ui-screenshot-sizes:bidder-detail" : "ui-screenshot-sizes:bids",
    async () => {
      assertionStage = "screenshot-ui-default-period";
      if (detail) {
        await page.goto(`${origin}${path}`);
        const initial = screenshotBidResponse(page, path, "today");
        await page
          .getByRole("tab", { name: "Bid activity", exact: true })
          .click();
        assert.equal((await initial).status(), 200);
      } else {
        const initial = screenshotBidResponse(page, path, "today");
        await page.goto(`${origin}${path}`);
        assert.equal((await initial).status(), 200);
      }
      await expect(
        page.getByLabel("Found period", { exact: true }),
      ).toHaveValue("today");
      await expect(page.getByText(/Loading bid applications/)).toHaveCount(0);
      const all = screenshotBidResponse(page, path, "all");
      await page
        .getByLabel("Found period", { exact: true })
        .selectOption("all");
      assert.equal((await all).status(), 200);
      await expect(
        page.getByLabel("Found period", { exact: true }),
      ).toHaveValue("all");
      await page
        .getByRole("button", { name: "Filter Screenshot", exact: true })
        .click();
      await expect(
        page.getByLabel("Screenshot filter", { exact: true }),
      ).toBeVisible();
      const smallest = page.getByRole("button", {
        name: "Size: smallest first",
        exact: true,
      });
      const largest = page.getByRole("button", {
        name: "Size: largest first",
        exact: true,
      });
      if (role === "bidder") {
        assertionStage = "screenshot-ui-bidder-absence";
        await expect(smallest).toHaveCount(0);
        await expect(largest).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(
          page.getByRole("button", { name: /^Screenshot size:/ }),
        ).toHaveCount(0);
        await expect(
          page.getByText("Size unavailable", { exact: true }),
        ).toHaveCount(0);
      } else {
        assertionStage = "screenshot-ui-manager-controls";
        await expect(smallest).toBeEnabled();
        await expect(largest).toBeEnabled();
        const ascending = screenshotBidResponse(page, path, "all", {
          id: "screenshot_size_bytes",
          desc: false,
        });
        await smallest.click();
        assert.equal((await ascending).status(), 200);
        await page
          .getByRole("button", { name: "Filter Screenshot", exact: true })
          .click();
        await expect(smallest).toHaveAttribute("aria-pressed", "true");
        const descending = screenshotBidResponse(page, path, "all", {
          id: "screenshot_size_bytes",
          desc: true,
        });
        await largest.click();
        assert.equal((await descending).status(), 200);
        await page
          .getByRole("button", { name: "Filter Screenshot", exact: true })
          .click();
        await expect(largest).toHaveAttribute("aria-pressed", "true");
        await page.keyboard.press("Escape");
        await expect(page.getByText(/Loading bid applications/)).toHaveCount(0);
        const badges = page.getByRole("button", { name: /^Screenshot size:/ });
        const expected = screenshotUiExpected(
          oracle,
          detail ? sample.bidder_id : undefined,
        );
        // Largest-first puts an eligible screenshot on the first page whenever
        // the independently authorized result has any valid current metadata.
        if (expected) {
          assertionStage = "screenshot-ui-exact-byte-popover";
          const badge = badges.first();
          await expect(badge).toBeVisible();
          const accessible = await badge.getAttribute("aria-label");
          const match =
            /^Screenshot size: ([\d,]+) bytes; (\d+) screenshots? with this exact size in current results$/.exec(
              accessible ?? "",
            );
          assert.ok(match);
          assert.equal(Number(match[1].replaceAll(",", "")), expected.bytes);
          assert.equal(Number(match[2]), expected.count);
          const exactBytes = expected.bytes.toLocaleString("en-US");
          const exactMatches = `${expected.count} screenshot${expected.count === 1 ? "" : "s"} with this exact size in current results (including this screenshot).`;
          await badge.focus();
          await page.keyboard.press("Enter");
          await expect(
            page.getByText(`${exactBytes} bytes`, { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText(exactMatches, { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText(
              "Matching file size is a review aid; it does not prove identical image content.",
              { exact: true },
            ),
          ).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(badge).toBeFocused();
          await badge.click();
          await expect(
            page.getByText(`${exactBytes} bytes`, { exact: true }),
          ).toBeVisible();
          await page.keyboard.press("Escape");
        } else {
          assertionStage = "screenshot-ui-no-eligible-metadata";
          await expect(badges).toHaveCount(0);
        }
        results.push({
          role,
          check: detail
            ? "screenshot-popover:detail-coverage"
            : "screenshot-popover:bids-coverage",
          passed: true,
          metadataBadgeAvailable: expected !== null,
          coverage: expected
            ? "badge-and-popover-verified"
            : "no-eligible-source-metadata",
        });
      }
      await clean();
    },
  );
}
function reportResponse(page, path, preset, bidderId) {
  return page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "POST" &&
      !!request.headers()["next-action"] &&
      new URL(request.url()).pathname === path &&
      (request.postData() ?? "").match(/"preset"\s*:\s*"([^\"]+)"/)?.[1] ===
        preset &&
      (!bidderId || JSON.parse(request.postData())[0]?.bidder === bidderId)
    );
  });
}
function bidResponse(page, path, preset, bidderId) {
  const pending = page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== "POST" || !request.headers()["next-action"] ||
        new URL(request.url()).pathname !== path) return false;
    const args = JSON.parse(request.postData() ?? "[]");
    return args[0] === preset && args[4] === bidderId;
  });
  // The triggering click can fail before this listener is awaited. Preserve the
  // rejected promise for its caller while preventing an unhandled rejection.
  pending.catch(() => {});
  return pending;
}
async function ui(role, session, sample) {
  const context = await browser.newContext();
  let page;
  let detailStarted = false;
  try {
    await context.addCookies(
      [...session.jar.values()]
        .filter((cookie) => cookie.value)
        .map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          url: origin,
          secure: true,
          httpOnly: false,
          sameSite: "Lax",
        })),
    );
    if (process.env.SMOKE_VERCEL_BYPASS)
      await context.setExtraHTTPHeaders({
        "x-vercel-protection-bypass": process.env.SMOKE_VERCEL_BYPASS,
      });
    page = await context.newPage();
    page.setDefaultTimeout(45000);
    const clean = async () => {
      // Next's accessibility route announcer is an alert in its own shadow root.
      // Retain every application alert; exclude only the framework host.
      const alertCounts = () => page.getByRole("alert").evaluateAll((alerts) => {
        let framework = 0;
        let application = 0;
        for (const alert of alerts) {
          const root = alert.getRootNode();
          if (root instanceof ShadowRoot && root.host.tagName === "NEXT-ROUTE-ANNOUNCER") framework++;
          else application++;
        }
        return { framework, application };
      });
      await expect.poll(async () => (await alertCounts()).application).toBe(0);
      const counts = await alertCounts();
      console.log(JSON.stringify({ role, check: "ui-alert-classification", ...counts }));
      const text = await page.locator("body").innerText();
      assert.ok(
        !/SQLSTATE|PGRST\d+|permission denied for|57014|function public\..*does not exist|column .*does not exist/i.test(
          text,
        ),
      );
    };
    const initialDashboardResponse = reportResponse(page, "/dashboard", "this_week");
    await page.goto(`${origin}/dashboard`);
    assert.equal((await initialDashboardResponse).status(), 200);
    await expect(page).toHaveURL(`${origin}/dashboard`);
    await expect(page.getByLabel("Period", { exact: true })).toHaveValue("this_week");
    for (const preset of ["this_week", "this_month", "all"]) {
      await measure(role, `ui-dashboard:${preset}`, async () => {
        if (await page.getByLabel("Period", { exact: true }).inputValue() !== preset) {
          const response = reportResponse(page, "/dashboard", preset);
          await page.getByLabel("Period", { exact: true }).selectOption(preset);
          assert.equal((await response).status(), 200);
        }
        await expect(page.getByLabel("Period", { exact: true })).toHaveValue(preset);
        await expect(
          page.getByRole("button", { name: "Refresh dashboard", exact: true }),
        ).toBeEnabled();
        assertionStage = "activity-chart";
        await expect(
          page.getByRole("img", { name: /^Activity chart: \d/ }),
        ).toBeVisible();
        assertionStage = "application-activity-heading";
        await expect(
          page.getByRole("heading", {
            name: "Application activity",
            exact: true,
          }),
        ).toBeVisible();
        assertionStage = "by-profile-heading";
        await expect(
          page.getByRole("heading", { name: "By profile", exact: true }),
        ).toBeVisible();
        if (checkArrangements) {
          assertionStage = "arrangement-breakdown";
          await expect(
            page.getByText("Breakdown unavailable", { exact: true }),
          ).toHaveCount(0);
          if (preset === "all")
            await expect(
              page.getByRole("img", { name: / Found: .*Remote/ }).first(),
            ).toBeVisible();
          for (const label of ["Bids", "Resumes", "Interviews"])
            await expect(
              page.getByRole("link", { name: label, exact: true }),
            ).toBeVisible();
          if (role === "manager")
            await expect(
              page.getByRole("link", { name: "Profiles", exact: true }),
            ).toBeVisible();
        }
        assertionStage = "no-embedded-grid";
        await expect(page.getByRole("grid")).toHaveCount(0);
        if (role === "manager") {
          assertionStage = "by-bidder-heading";
          await expect(
            page.getByRole("heading", { name: "By bidder", exact: true }),
          ).toBeVisible();
          assertionStage = "earned-label";
          await expect(page.getByText("Earned", { exact: true })).toBeVisible();
        } else {
          await expect(
            page.getByRole("heading", { name: "By bidder", exact: true }),
          ).toHaveCount(0);
          await expect(page.getByText("Earned", { exact: true })).toHaveCount(
            0,
          );
          await expect(
            page.getByRole("link", { name: "Earnings", exact: true }),
          ).toHaveCount(0);
        }
        assertionStage = "no-report-alert-or-sql-errors";
        await clean();
      });
    }
    const initialInterviewResponse = reportResponse(
      page,
      "/interviews",
      "all",
    );
    await page.goto(`${origin}/interviews`);
    assert.equal((await initialInterviewResponse).status(), 200);
    await expect(page.getByLabel("Cohort period", { exact: true })).toHaveValue("all");
    for (const preset of ["all", "this_month", "all"]) {
      await measure(role, `ui-interviews:${preset}`, async () => {
        assertionStage = "interview-cohort-period";
        if (await page.getByLabel("Cohort period", { exact: true }).inputValue() !== preset) {
          const response = reportResponse(page, "/interviews", preset);
          await page.getByLabel("Cohort period", { exact: true }).selectOption(preset);
          assert.equal((await response).status(), 200);
        }
        await expect(page.getByLabel("Cohort period", { exact: true })).toHaveValue(
          preset,
        );
        assertionStage = "interview-performance-heading";
        await expect(
          page.getByRole("heading", {
            name: "Interview performance",
            exact: true,
          }),
        ).toBeVisible();
        assertionStage = "applied-applications-column";
        await expect(
          page.getByRole("columnheader", {
            name: "Applied applications",
            exact: true,
          }),
        ).toBeVisible();
        assertionStage = "interview-loading-complete";
        await expect(page.getByText(/Loading interview report/)).toHaveCount(0);
        assertionStage = "no-report-alert-or-sql-errors";
        await clean();
      });
    }
    if (role === "manager") {
      const initialEarningsResponse = reportResponse(page, "/earnings", "this_week");
      await page.goto(`${origin}/earnings`);
      assert.equal((await initialEarningsResponse).status(), 200);
      await expect(page).toHaveURL(`${origin}/earnings`);
      await expect(page.getByLabel("First applied period", { exact: true })).toHaveValue("this_week");
      for (const preset of ["this_week", "this_month", "all"]) {
        await measure(role, `ui-earnings:${preset}`, async () => {
          if (await page.getByLabel("First applied period", { exact: true }).inputValue() !== preset) {
            const response = reportResponse(page, "/earnings", preset);
            await page.getByLabel("First applied period", { exact: true }).selectOption(preset);
            assert.equal((await response).status(), 200);
          }
          await expect(page.getByLabel("First applied period", { exact: true })).toHaveValue(preset);
          await expect(page.getByText(/Loading earnings/)).toHaveCount(0);
          await clean();
        });
      }
      if (stagingMode) {
        step = "manager:bidder-detail";
        assertionStage = "bidder-detail-navigation";
        detailStarted = true;
        const path = `/users/${sample.bidder_id}`;
        await page.goto(`${origin}${path}`);
        await expect(page).toHaveURL(`${origin}${path}`);
        await expect(page.getByRole("tab", { name: "Bid activity", exact: true })).toBeVisible();
        const initialBidsResponse = bidResponse(page, path, "today", sample.bidder_id);
        assertionStage = "bidder-detail-bid-tab-click";
        await page.getByRole("tab", { name: "Bid activity", exact: true }).click();
        assertionStage = "bidder-detail-bid-tab-active";
        await expect(page.getByRole("tab", { name: "Bid activity", exact: true })).toHaveAttribute("aria-selected", "true");
        assertionStage = "bidder-detail-initial-bid-response";
        assert.equal((await initialBidsResponse).status(), 200);
        await expect(page.getByLabel("Found period", { exact: true })).toHaveValue("today");
        await measure(role, "ui-bidder-detail:bids-today-and-all", async () => {
          await expect(page.getByText(/^\d+\u2013\d+ of \d+ bids$/)).toBeVisible();
          await clean();
          const response = bidResponse(page, path, "all", sample.bidder_id);
          await page.getByLabel("Found period", { exact: true }).selectOption("all");
          assert.equal((await response).status(), 200);
          await expect(page.getByLabel("Found period", { exact: true })).toHaveValue("all");
          await expect(page.getByText(/^\d+\u2013\d+ of \d+ bids$/)).toBeVisible();
          await clean();
        });
        const initialDetailEarnings = reportResponse(page, path, "this_week", sample.bidder_id);
        assertionStage = "bidder-detail-earnings-tab-click";
        await page.getByRole("tab", { name: "Earnings", exact: true }).click();
        await expect(page.getByRole("tab", { name: "Earnings", exact: true })).toHaveAttribute("aria-selected", "true");
        assert.equal((await initialDetailEarnings).status(), 200);
        await expect(page.getByLabel("First applied period", { exact: true })).toHaveValue("this_week");
        await measure(role, "ui-bidder-detail:earnings-week-and-all", async () => {
          await expect(page.getByText(/Loading earnings/)).toHaveCount(0);
          await clean();
          const response = reportResponse(page, path, "all", sample.bidder_id);
          await page.getByLabel("First applied period", { exact: true }).selectOption("all");
          assert.equal((await response).status(), 200);
          await expect(page.getByLabel("First applied period", { exact: true })).toHaveValue("all");
          await expect(page.getByText(/Loading earnings/)).toHaveCount(0);
          await clean();
        });
      }
    }
    if (checkScreenshotSizes) {
      await screenshotSizeUi(role, page, sample, clean, session.screenshotOracle);
      if (role === "manager") await screenshotSizeUi(role, page, sample, clean, session.screenshotOracle, true);
    }
    if (role === "bidder")
      await measure(role, "ui-earnings-denied", async () => {
        await page.goto(`${origin}/earnings`);
        await expect(page).toHaveURL(`${origin}/dashboard`);
        await expect(page.getByText("Earned", { exact: true })).toHaveCount(0);
      });
  } catch (error) {
    if (detailStarted && page) {
      await page.screenshot({ path: "test-results/page-defaults-detail-failure.png", fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    await context.close();
  }
}
async function main() {
  if (
    productionMode === stagingMode ||
    process.env.NEXT_PUBLIC_SUPABASE_URL !== expectedUrl
  )
    throw new Error("Requires exactly one hosted read-only mode and its exact Supabase URL");
  if (
    !process.env.SUPABASE_SECRET_KEY ||
    !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  )
    throw new Error("Missing required hosted credentials");
  const service = createClient(expectedUrl, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  step = "choose-existing-actors";
  const actors = await chooseActors(service);
  browser = await chromium.launch();
  for (const role of ["manager", "bidder"]) {
    step = `${role}:no-email-session`;
    const session = await authenticate(service, actors[role]);
    await reports(role, session.client, actors.sample.workspace_id);
    await boundary(role, session.client, actors.sample);
    if (checkScreenshotSizes) {
      session.screenshotOracle = await screenshotOracle(session.client);
      await screenshotSizes(role, session.client, actors.sample, session.screenshotOracle);
    }
    await ui(role, session, actors.sample);
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        environment: stagingMode ? "staging" : "production",
        customerDataReadOnly: true,
        existingRolesChecked: 2,
        checks: results,
      },
      null,
      2,
    ),
  );
}
try {
  await main();
} catch (error) {
  // Never print assertion values, identities, credentials, response bodies or raw provider errors.
  console.error(
    JSON.stringify({
      passed: false,
      customerDataReadOnly: true,
      step,
      assertionStage,
      strictLocatorAmbiguity: String(error?.message ?? "").includes("strict mode violation"),
      code: error?.code ?? error?.name ?? "Error",
      completedChecks: results.length,
    }),
  );
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const session of sessions)
    await session.auth.signOut({ scope: "local" }).catch(() => {});
}
