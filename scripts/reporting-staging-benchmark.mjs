// Dedicated staging synthetic reporting acceptance. Never run against production.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";
import { formatInTimeZone } from "date-fns-tz";
assert.equal(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  "https://kdmvludtvhuuewmhurpw.supabase.co",
  "Dedicated staging only",
);
assert.ok(
  process.argv.includes("--staging-ready"),
  "Root must confirm migrations ready via --staging-ready before fixture mutations",
);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
  key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  secret = process.env.SUPABASE_SECRET_KEY;
assert.ok(key && secret, "Staging publishable and service keys required");
const options = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
  },
};
const service = createClient(url, secret, options);
const fixtureCount = 25000;
const marker = `report-bench-${randomUUID()}`,
  password = `Bench-${randomUUID()}!`;
const users = [],
  workspaces = [],
  assignments = [],
  live = [],
  history = [],
  results = [];
let workspace,
  cleanupComplete = false,
  failed = false;
const today = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
const shift = (day, n) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000)
    .toISOString()
    .slice(0, 10);
const ranges = [
  { name: "all", from: null, to: null },
  { name: "recent", from: shift(today, -29), to: today },
];
const receipt = {
  marker,
  at: new Date().toISOString(),
  fixtureBids: fixtureCount,
  syntheticUserIds: users,
  syntheticWorkspaceIds: workspaces,
  ranges,
  results,
};
function ok(result) {
  if (result.error) {
    const error = new Error(
      `Hosted operation failed (${result.error.code ?? result.error.status ?? "unknown"})`,
    );
    error.code = result.error.code;
    throw error;
  }
  return result.data;
}
async function account(label, role) {
  const email = `${marker}-${label}@example.com`;
  const user = ok(
    await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: `Report benchmark ${label}` },
    }),
  ).user;
  users.push(user.id);
  ok(
    await service
      .from("profiles")
      .update({ role, approval_status: "approved" })
      .eq("id", user.id),
  );
  const ws = ok(
    await service.from("workspaces").select("id").eq("owner_id", user.id),
  );
  workspaces.push(...ws.map((row) => row.id));
  const authenticated = createClient(url, key, options);
  ok(await authenticated.auth.signInWithPassword({ email, password }));
  return { id: user.id, client: authenticated, role, workspace: ws[0]?.id };
}
function expected(actor, range) {
  const selected = live.filter(
    (row) =>
      (actor.role !== "bidder" || row.bidder_id === actor.id) &&
      !row.deleted_at,
  );
  const retained = history.filter(
    (row) => actor.role !== "bidder" || row.bidder_id === actor.id,
  );
  const inRange = (day) =>
    (!range.from || day >= range.from) && (!range.to || day <= range.to);
  const found = selected.filter((row) => inRange(row.found_at.slice(0, 10))),
    activity = selected.filter(
      (row) => row.applied && inRange(row.applied_at.slice(0, 10)),
    ),
    cohort = selected.filter(
      (row) => row.applied && inRange(row.first_applied_at.slice(0, 10)),
    );
  const hFound = retained.filter(
      (row) => row.metric === "found" && inRange(row.report_day),
    ),
    hActivity = retained.filter(
      (row) => row.metric === "applied_activity" && inRange(row.report_day),
    ),
    hEarn = retained.filter(
      (row) => row.metric === "earning" && inRange(row.report_day),
    );
  const sum = (rows, key) =>
    rows.reduce((total, row) => total + (row[key] ?? 0), 0);
  return {
    found: found.length + sum(hFound, "record_count"),
    foundApplied:
      found.filter((row) => row.applied).length + sum(hFound, "record_count"),
    appliedActivity: activity.length + sum(hActivity, "record_count"),
    trackedApplications: cohort.length + sum(hEarn, "tracked_count"),
    trackedInterviews:
      cohort.filter((row) => row.interview_scheduled).length +
      sum(hEarn, "interview_count"),
    earningsCents: sum(cohort, "rate_cents") + sum(hEarn, "earned_cents"),
    earningsCount: cohort.length + sum(hEarn, "record_count"),
    retainedCount: sum(hEarn, "record_count"),
    excluded: sum(hEarn, "record_count") - sum(hEarn, "tracked_count"),
  };
}
function validate(name, data, e, actor) {
  const sum = (rows, key) => rows.reduce((n, row) => n + row[key], 0);
  if (name === "dashboard_performance_v2") {
    assert.deepEqual(data.totals, {
      found: e.found,
      foundApplied: e.foundApplied,
      appliedActivity: e.appliedActivity,
      trackedApplications: e.trackedApplications,
      trackedInterviews: e.trackedInterviews,
    });
    assert.ok(data.series.length <= 120);
    for (const groups of Object.values(data.comparisons)) {
      assert.equal(new Set(groups.map((g) => g.id)).size, groups.length);
      assert.equal(sum(groups, "found"), e.found);
      assert.equal(sum(groups, "foundApplied"), e.foundApplied);
    }
    assert.equal(sum(data.series, "found"), e.found);
    assert.equal(sum(data.series, "applied"), e.appliedActivity);
    if (actor.role === "bidder") assert.ok(!Object.hasOwn(data, "financial"));
    else
      assert.deepEqual(data.financial, {
        earningsCents: e.earningsCents,
        earningsCount: e.earningsCount,
      });
  } else if (name === "earnings_performance_v2") {
    assert.equal(data.totals.count, e.earningsCount);
    assert.equal(data.totals.cents, e.earningsCents);
    assert.equal(data.totals.retainedCount, e.retainedCount);
    assert.equal(data.totals.trackedApplications, e.trackedApplications);
    assert.equal(data.totals.trackedInterviews, e.trackedInterviews);
    assert.equal(sum(data.groups, "cents"), e.earningsCents);
    assert.equal(sum(data.groups, "count"), e.earningsCount);
    assert.equal(sum(data.groups, "applied"), e.trackedApplications);
    assert.equal(sum(data.groups, "interviews"), e.trackedInterviews);
  } else {
    assert.deepEqual(data.totals, {
      applied: e.trackedApplications,
      interviews: e.trackedInterviews,
      excludedApplications: e.excluded,
    });
    assert.equal(sum(data.groups, "applied"), e.trackedApplications);
    assert.equal(sum(data.groups, "interviews"), e.trackedInterviews);
    for (const g of data.groups)
      assert.equal(
        g.conversion,
        g.applied === 0
          ? null
          : Math.round((g.interviews * 1000) / g.applied) / 10,
      );
    assert.ok(!/cents|earnings|rate_cents/i.test(JSON.stringify(data)));
  }
  if (data.groups)
    assert.equal(
      new Set(data.groups.map((g) => g.id)).size,
      data.groups.length,
    );
}
async function cleanup() {
  if (!users.length) return;
  const owned = ok(
    await service.from("workspaces").select("id").in("owner_id", users),
  );
  const ws = [...new Set([...workspaces, ...owned.map((row) => row.id)])];
  if (ws.length) {
    for (const table of [
      "bids",
      "retained_bid_daily_aggregates",
      "resumes",
      "candidate_profiles",
      "invitations",
      "bidders",
    ])
      ok(await service.from(table).delete().in("workspace_id", ws));
    ok(await service.from("workspaces").delete().in("id", ws));
  }
  ok(await service.from("account_events").delete().in("account_id", users));
  ok(
    await service
      .from("profiles")
      .update({ reviewed_by: null })
      .in("id", users),
  );
  ok(await service.from("profiles").delete().in("id", users));
  for (const id of users) ok(await service.auth.admin.deleteUser(id));
  const cleanupCounts = {};
  for (const table of [
    "bids",
    "retained_bid_daily_aggregates",
    "resumes",
    "candidate_profiles",
    "bidders",
  ]) {
    const response = await service
      .from(table)
      .select(
        table === "bidders"
          ? "user_id"
          : table === "retained_bid_daily_aggregates"
            ? "report_day"
            : "id",
        { count: "exact", head: true },
      )
      .in("workspace_id", ws);
    ok(response);
    cleanupCounts[table] = response.count;
    assert.equal(
      response.count,
      0,
      `Synthetic ${table} cleanup verification failed`,
    );
  }
  for (const [table, ids] of [
    ["workspaces", ws],
    ["profiles", users],
  ]) {
    const response = await service
      .from(table)
      .select("id", { count: "exact", head: true })
      .in("id", ids);
    ok(response);
    cleanupCounts[table] = response.count;
    assert.equal(
      response.count,
      0,
      `Synthetic ${table} cleanup verification failed`,
    );
  }
  receipt.cleanupCounts = cleanupCounts;
  cleanupComplete = true;
}
try {
  const owner = await account("owner", "client"),
    administrator = await account("admin", "admin"),
    b1 = await account("bidder1", "bidder"),
    b2 = await account("bidder2", "bidder");
  workspace = owner.workspace;
  assert.ok(workspace);
  ok(
    await service.from("bidders").insert([
      { user_id: b1.id, workspace_id: workspace, default_rate_cents: 100 },
      { user_id: b2.id, workspace_id: workspace, default_rate_cents: 125 },
    ]),
  );
  const profiles = [randomUUID(), randomUUID()];
  ok(
    await service.from("candidate_profiles").insert(
      profiles.map((id, i) => ({
        id,
        workspace_id: workspace,
        identifier: `${marker}-${i}`,
        candidate_name: "Benchmark shared profile",
        retention_months: null,
      })),
    ),
  );
  for (const [profile, bidder] of [
    [profiles[0], b1.id],
    [profiles[0], b2.id],
    [profiles[1], b1.id],
  ])
    assignments.push({
      id: randomUUID(),
      workspace_id: workspace,
      bidder_id: bidder,
      profile_id: profile,
      identifier: marker,
      candidate_name: "Benchmark candidate",
    });
  ok(await service.from("resumes").insert(assignments));
  for (let i = 0; i < fixtureCount; i++) {
    const assignment = assignments[i % 10 === 0 ? 2 : i % 10 < 4 ? 1 : 0],
      found = i % 4 === 0 ? "2010-01-01" : shift(today, -(i % 28)),
      applied = i % 3 !== 0;
    live.push({
      id: randomUUID(),
      workspace_id: workspace,
      bidder_id: assignment.bidder_id,
      resume_id: assignment.id,
      company: `${marker}-${i}`,
      role_name: "Benchmark engineer",
      url: `https://benchmark.invalid/${marker}/${i}`,
      normalized_url: `https://benchmark.invalid/${marker}/${i}`,
      arrangement: "remote",
      found_at: `${found}T18:00:00Z`,
      applied,
      application_method: applied ? "manual" : null,
      rate_cents: applied ? 100 + (i % 5) * 25 : null,
      first_applied_at: applied ? `${found}T18:00:00Z` : null,
      applied_at: applied ? `${today}T18:00:00Z` : null,
      interview_scheduled: applied && i % 5 === 0,
      deleted_at: i % 11 === 0 ? `${today}T18:00:00Z` : null,
    });
  }
  for (let start = 0; start < live.length; start += 500)
    ok(await service.from("bids").insert(live.slice(start, start + 500)));
  for (const assignment of assignments)
    for (const day of ["1990-01-01", today])
      for (const metric of ["found", "applied_activity", "earning"])
        history.push({
          workspace_id: workspace,
          bidder_id: assignment.bidder_id,
          profile_id: assignment.profile_id,
          resume_id: assignment.id,
          report_day: day,
          metric,
          record_count: metric === "found" ? 20 : 15,
          earned_cents: metric === "earning" ? 1500 : 0,
          tracked_count: metric === "earning" ? 10 : 0,
          interview_count: metric === "earning" ? 2 : 0,
        });
  ok(await service.from("retained_bid_daily_aggregates").insert(history));
  receipt.fixtureRetainedRows = history.length;
  const count = await service
    .from("bids")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspace);
  ok(count);
  assert.equal(count.count, fixtureCount);
  console.log(
    `Fixture seeded: ${fixtureCount} bids, ${history.length} retained rows, ${assignments.length} shared assignments`,
  );
  for (const actor of [owner, administrator, b1])
    for (const range of ranges)
      for (const name of [
        "dashboard_performance_v2",
        "interview_performance",
        "earnings_performance_v2",
      ]) {
        const samples = [],
          e = expected(actor, range);
        let denials = 0;
        for (let wave = 0; wave < 5; wave++)
          await Promise.all(
            Array.from({ length: 5 }, async () => {
              const start = performance.now();
              const response = await actor.client.rpc(name, {
                p_from: range.from,
                p_to: range.to,
                p_workspace: workspace,
              });
              const durationMs = performance.now() - start;
              if (
                actor.role === "bidder" &&
                name === "earnings_performance_v2"
              ) {
                assert.ok(response.error);
                assert.notEqual(response.error.code, "57014");
                assert.equal(response.error.message, "Access denied");
                denials++;
              } else validate(name, ok(response), e, actor);
              samples.push(durationMs);
            }),
          );
        samples.sort((a, b) => a - b);
        const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
        const measurement = {
          role: actor.role,
          range: range.name,
          rpc: name,
          samples: samples.length,
          concurrency: 5,
          p95Ms: Math.round(p95),
          maxMs: Math.round(samples.at(-1)),
          expectedDenials: denials,
        };
        results.push(measurement);
        console.log(JSON.stringify(measurement));
      }
  receipt.passed = results.every((measurement) => measurement.p95Ms < 2000);
  failed = !receipt.passed;
} catch (error) {
  failed = true;
  receipt.passed = false;
  receipt.failure = {
    code: error.code ?? error.name,
    message:
      error.name === "AssertionError"
        ? error.message
        : "Hosted operation failed (details withheld)",
  };
  console.error(JSON.stringify(receipt.failure));
} finally {
  try {
    await cleanup();
  } catch (error) {
    failed = true;
    receipt.cleanupError = { code: error.code ?? error.name };
    console.error(
      "Synthetic fixture cleanup incomplete; consult receipt marker and retry only this fixture",
    );
  }
  receipt.cleanupComplete = cleanupComplete;
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/reporting-staging-benchmark.json",
    JSON.stringify(receipt, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: receipt.passed,
      cleanupComplete,
      receipt: "test-results/reporting-staging-benchmark.json",
    }),
  );
}
if (failed) process.exitCode = 1;
