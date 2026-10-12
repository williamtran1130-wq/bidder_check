// Production reporting acceptance: read-only customer/application data.
// Explicit auth exception: generate a no-email link for EXISTING accounts,
// verify an isolated session, and revoke only that generated local session.
// node --env-file=.env.local scripts/reporting-production-smoke.mjs --production-read-only
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { formatInTimeZone } from "date-fns-tz";
import { chromium, expect as baseExpect } from "@playwright/test";

const expectedUrl = "https://aizorlyfggwbewetnwqm.supabase.co";
const origin = "https://bidder-check.vercel.app";
const expect = baseExpect.configure({ timeout: 45000 });
const sessions = [];
const results = [];
let browser;
let step = "configuration";
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
  for (const preset of ["this_month", "all"]) {
    const range =
      preset === "all"
        ? { p_from: null, p_to: null }
        : { p_from: `${today.slice(0, 7)}-01`, p_to: today };
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
function reportResponse(page, path, preset) {
  return page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "POST" &&
      !!request.headers()["next-action"] &&
      new URL(request.url()).pathname === path &&
      (request.postData() ?? "").match(/"preset"\s*:\s*"([^\"]+)"/)?.[1] ===
        preset
    );
  });
}
async function ui(role, session) {
  const context = await browser.newContext();
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
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    const clean = async () => {
      await expect(page.getByRole("alert")).toHaveCount(0);
      const text = await page.locator("body").innerText();
      assert.ok(
        !/SQLSTATE|PGRST\d+|permission denied for|57014|function public\..*does not exist|column .*does not exist/i.test(
          text,
        ),
      );
    };
    await page.goto(`${origin}/dashboard`);
    await expect(page).toHaveURL(`${origin}/dashboard`);
    for (const preset of ["this_month", "all"]) {
      await measure(role, `ui-dashboard:${preset}`, async () => {
        if (preset !== "this_month") {
          const response = reportResponse(page, "/dashboard", preset);
          await page.getByLabel("Period", { exact: true }).selectOption(preset);
          assert.equal((await response).status(), 200);
        }
        await expect(
          page.getByRole("button", { name: "Refresh dashboard", exact: true }),
        ).toBeEnabled();
        await expect(
          page.getByRole("img", { name: /^Activity chart: \d/ }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", {
            name: "Application activity",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "By profile", exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("grid")).toHaveCount(0);
        if (role === "manager") {
          await expect(
            page.getByRole("heading", { name: "By bidder", exact: true }),
          ).toBeVisible();
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
        await clean();
      });
    }
    const initialInterviewResponse = reportResponse(
      page,
      "/interviews",
      "this_month",
    );
    await page.goto(`${origin}/interviews`);
    assert.equal((await initialInterviewResponse).status(), 200);
    for (const preset of ["this_month", "all"]) {
      await measure(role, `ui-interviews:${preset}`, async () => {
        if (preset !== "this_month") {
          const response = reportResponse(page, "/interviews", preset);
          await page.getByLabel("Period", { exact: true }).selectOption(preset);
          assert.equal((await response).status(), 200);
        }
        await expect(page.getByLabel("Period", { exact: true })).toHaveValue(
          preset,
        );
        await expect(
          page.getByRole("heading", {
            name: "Interview performance",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("columnheader", {
            name: "Applied applications",
            exact: true,
          }),
        ).toBeVisible();
        await expect(page.getByText(/Loading interview report/)).toHaveCount(0);
        await clean();
      });
    }
    if (role === "bidder")
      await measure(role, "ui-earnings-denied", async () => {
        await page.goto(`${origin}/earnings`);
        await expect(page).toHaveURL(`${origin}/dashboard`);
        await expect(page.getByText("Earned", { exact: true })).toHaveCount(0);
      });
  } finally {
    await context.close();
  }
}
async function main() {
  if (
    !process.argv.includes("--production-read-only") ||
    process.env.NEXT_PUBLIC_SUPABASE_URL !== expectedUrl
  )
    throw new Error("Requires exact production URL and --production-read-only");
  if (
    !process.env.SUPABASE_SECRET_KEY ||
    !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  )
    throw new Error("Missing required production credentials");
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
    await ui(role, session);
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
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
