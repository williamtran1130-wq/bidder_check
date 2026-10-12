// Guarded, synthetic-only staging acceptance. No storage objects are uploaded.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { seedChunk } from "./screenshot-size-seed-reconciliation.mjs";
import {
  assertFreshPlan,
  verifyUnusedPlan,
  claimPlan,
} from "./screenshot-size-benchmark-plan.mjs";

const STAGING = "https://kdmvludtvhuuewmhurpw.supabase.co";
const PREFIX = "screenshot-size-bench-";
const LABELS = ["owner", "admin", "bidder1", "bidder2", "outsider"];
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const args = process.argv.slice(2);
const before = args.includes("--before");
const recovery = args.includes("--cleanup-only");
const keep = args.includes("--keep-fixture");
const results = [];
const sessions = [];
let service, receipt, receiptPath;
let failed = false;

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  assert.ok(
    args[index + 1] && !args[index + 1].startsWith("--"),
    `Value required for ${name}`,
  );
  return args[index + 1];
}
function guardedPath(value) {
  const root = path.resolve(".superpowers");
  const resolved = path.resolve(value);
  const relative = path.relative(root, resolved);
  assert.ok(
    relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    "Receipt must be beneath .superpowers",
  );
  assert.equal(path.extname(resolved), ".json", "Receipt must be JSON");
  return resolved;
}
function validateReceipt(value) {
  assert.equal(value.version, 1, "Unsupported receipt");
  assert.equal(
    value.target,
    STAGING,
    "Receipt target is not dedicated staging",
  );
  assert.match(value.marker, new RegExp(`^${PREFIX}[0-9a-f-]{36}$`));
  assert.match(value.marker.slice(PREFIX.length), UUID);
  assert.ok(["before", "after"].includes(value.mode));
  assert.equal(value.fixtureBids, 25000);
  assert.equal(value.accounts.length, LABELS.length);
  assert.equal(new Set(value.accounts.map((a) => a.id)).size, LABELS.length);
  value.accounts.forEach((account, index) => {
    assert.equal(account.label, LABELS[index]);
    assert.match(account.id, UUID);
    assert.equal(account.email, `${value.marker}-${account.label}@example.com`);
  });
  assert.ok(
    Array.isArray(value.workspaceIds) &&
      value.workspaceIds.length <= LABELS.length,
  );
  for (const id of value.workspaceIds) assert.match(id, UUID);
}
async function save(initial = false) {
  receipt.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const temporary = initial ? receiptPath : `${receiptPath}.tmp`;
  const handle = await open(temporary, initial ? "wx" : "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(receipt, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!initial) await rename(temporary, receiptPath);
}
function ok(response) {
  if (response.error) {
    const error = new Error("Hosted operation failed (details withheld)");
    error.code = response.error.code ?? response.error.status ?? "unknown";
    throw error;
  }
  return response.data;
}
function noMoney(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(
      !/financial|cents|earnings|rate_override|default_rate/i.test(key),
    );
    noMoney(nested);
  }
}
async function chunks(rows, action, size = 500) {
  for (let start = 0; start < rows.length; start += size)
    await action(rows.slice(start, start + size));
}
function seed(table, operation, rows) {
  return seedChunk({ service, receipt, table, operation, rows, check: ok, save });
}
async function account(planned, role, sponsor) {
  // Managed provisioning suppresses public signup alerts/pushes to real admins.
  // The bootstrap sponsor is referenced only by the isolated provision row.
  receipt.phase = `provision:${planned.label}`;
  await save();
  ok(
    await service.from("client_provisions").insert({
      id: planned.id,
      email: planned.email,
      display_name: `Screenshot benchmark ${planned.label}`,
      created_by: sponsor,
    }),
  );
  const password = `Bench-${randomUUID()}!`;
  const user = ok(
    await service.auth.admin.createUser({
      id: planned.id,
      email: planned.email,
      password,
      email_confirm: true,
      user_metadata: { display_name: `Screenshot benchmark ${planned.label}` },
    }),
  ).user;
  assert.equal(user.id, planned.id);
  ok(
    await service
      .from("profiles")
      .update({ role, approval_status: "approved" })
      .eq("id", planned.id),
  );
  const workspaces = ok(
    await service.from("workspaces").select("id").eq("owner_id", planned.id),
  );
  assert.equal(workspaces.length, 1);
  receipt.workspaceIds.push(workspaces[0].id);
  await save();
  const client = createClient(
    STAGING,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    options,
  );
  ok(await client.auth.signInWithPassword({ email: planned.email, password }));
  sessions.push(client);
  return { id: planned.id, role, workspace: workspaces[0].id, client };
}
const options = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
  },
};
const shift = (day, n) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000)
    .toISOString()
    .slice(0, 10);
function fixture(actors, marker, today, count = 25000) {
  const main = actors.owner.workspace;
  const secondary = actors.admin.workspace;
  const assignments = [actors.bidder1, actors.bidder2, actors.outsider].map(
    (actor, index) => ({
      id: randomUUID(),
      workspace_id: index === 2 ? secondary : main,
      bidder_id: actor.id,
      profile_id: randomUUID(),
      identifier: `${marker}-${index}`,
      candidate_name: "Synthetic candidate",
    }),
  );
  const bids = [],
    files = [],
    bytes = new Map();
  for (let index = 0; index < count + 5; index++) {
    const extra = index >= count;
    const assignment = assignments[extra ? 2 : index % 2];
    const day = index % 4 === 0 ? "2010-01-01" : shift(today, -(index % 28));
    bids.push({
      id: randomUUID(),
      workspace_id: assignment.workspace_id,
      bidder_id: assignment.bidder_id,
      resume_id: assignment.id,
      company: `${marker}-${extra ? "outside" : "main"}-${index}`,
      role_name: "Synthetic engineer",
      url: `https://benchmark.invalid/${marker}/${index}`,
      normalized_url: `https://benchmark.invalid/${marker}/${index}`,
      source: "synthetic",
      arrangement: ["remote", "onsite", "hybrid"][index % 3],
      found_at: `${day}T18:00:00Z`,
      review_status: "approved",
      review_revision: 1,
      applied: index % 16 === 1,
      application_method: index % 16 === 1 ? "manual" : null,
      rate_cents: index % 16 === 1 ? 100 : null,
      applied_at: index % 16 === 1 ? `${day}T18:00:00Z` : null,
      first_applied_at: index % 16 === 1 ? `${day}T18:00:00Z` : null,
      evidence_file_id: null,
      deleted_at: null,
    });
  }
  for (let index = 0; index < bids.length; index++) {
    const bid = bids[index],
      kind = index % 16;
    let size = null;
    const addFile = (overrides = {}) => {
      const file = {
        id: randomUUID(),
        workspace_id: bid.workspace_id,
        bidder_id: bid.bidder_id,
        bid_id: bid.id,
        kind: "screenshot",
        filename: "synthetic.png",
        mime: "image/png",
        size_bytes: 777777,
        storage_path: `${marker}/${bid.id}/${randomUUID()}.png`,
        sha256: "a".repeat(64),
        finalized: true,
        created_by: bid.bidder_id,
        review_revision: 1,
        ...overrides,
      };
      files.push(file);
      return file;
    };
    if (kind >= 4 && kind <= 11) {
      size = [
        333333,
        100000 + index,
        102399,
        102400,
        1048576,
        2097152,
        5242880,
        10485760,
      ][kind - 4];
      bid.evidence_file_id = addFile({ size_bytes: size }).id;
      if (kind === 4) addFile(); // Historical finalized evidence must not count.
    } else if (kind === 2) {
      bid.evidence_file_id = addFile({ finalized: false }).id;
    } else if (kind === 3) {
      addFile(); // Historical-only evidence; current pointer is null.
    } else if (kind === 12) {
      bid.evidence_file_id = addFile({
        bid_id: bids[(index + 1) % bids.length].id,
      }).id;
    } else if (kind === 13 && index < count) {
      bid.evidence_file_id = addFile({
        bidder_id:
          bid.bidder_id === actors.bidder1.id
            ? actors.bidder2.id
            : actors.bidder1.id,
      }).id;
    } else if (kind === 14 && index < count) {
      bid.evidence_file_id = addFile({
        workspace_id: secondary,
        bidder_id: actors.outsider.id,
      }).id;
    }
    bytes.set(bid.id, size);
  }
  const finalBids = bids.map((bid, index) => ({
    ...bid,
    ...(bytes.get(bid.id) !== null
      ? {
          applied: true,
          application_method: "screenshot",
          rate_cents: 100,
          applied_at: bid.found_at,
          first_applied_at: bid.found_at,
        }
      : {}),
    deleted_at: index % 37 === 0 ? `${today}T18:00:00Z` : null,
  }));
  return { assignments, bids, finalBids, files, bytes };
}
function selected(fixture, actor, range, scope, search) {
  return fixture.finalBids.filter(
    (bid) =>
      !bid.deleted_at &&
      bid.company.includes(search) &&
      (actor.role === "admin" ||
        bid.workspace_id === actor.workspace ||
        (actor.role === "bidder" && bid.bidder_id === actor.id)) &&
      (actor.role !== "bidder" || bid.bidder_id === actor.id) &&
      (!scope || bid.bidder_id === scope) &&
      (!range.from || Date.parse(bid.found_at) >= Date.parse(range.from)) &&
      (!range.to || Date.parse(bid.found_at) < Date.parse(range.to)),
  );
}
function expected(fixture, actor, range, sort, scope, search) {
  const rows = selected(fixture, actor, range, scope, search);
  const counts = new Map();
  for (const row of rows) {
    const size = fixture.bytes.get(row.id);
    if (size !== null) counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  const compare = (a, b) => {
    let primary = 0;
    if (sort.id === "screenshot_size_bytes" && actor.role !== "bidder") {
      const sa = fixture.bytes.get(a.id),
        sb = fixture.bytes.get(b.id);
      if (sa === null && sb !== null) return 1;
      if (sb === null && sa !== null) return -1;
      primary = sa === null ? 0 : (sa - sb) * (sort.desc ? -1 : 1);
    } else if (sort.id === "screenshot") {
      primary =
        (Number(!!a.evidence_file_id) - Number(!!b.evidence_file_id)) *
        (sort.desc ? -1 : 1);
    } else
      primary =
        (Date.parse(a.found_at) - Date.parse(b.found_at)) *
        (sort.desc ? -1 : 1);
    return (
      primary ||
      Date.parse(b.found_at) - Date.parse(a.found_at) ||
      a.id.localeCompare(b.id)
    );
  };
  rows.sort(compare);
  return { rows, counts };
}
function validate(data, e, actor, pageIndex, pageSize, checkFeature) {
  assert.equal(data.total, e.rows.length);
  assert.deepEqual(
    data.rows.map((row) => row.id),
    e.rows
      .slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
      .map((row) => row.id),
  );
  noMoney(data.rows);
  const positions = new Map(e.rows.map((row) => [row.id, row]));
  for (const row of data.rows) {
    assert.equal(row.workspace_id, positions.get(row.id).workspace_id);
    if (actor.role === "bidder" || !checkFeature) {
      assert.ok(!Object.hasOwn(row, "screenshot_size_bytes"));
      assert.ok(!Object.hasOwn(row, "screenshot_size_match_count"));
    } else {
      const size = fixtureData.bytes.get(row.id);
      assert.equal(row.screenshot_size_bytes, size);
      assert.equal(
        row.screenshot_size_match_count,
        size === null ? 0 : e.counts.get(size),
      );
    }
  }
}
let fixtureData;
async function benchmark(
  actor,
  range,
  sort,
  scope,
  search,
  checkFeature,
  label = "main",
) {
  const e = expected(fixtureData, actor, range, sort, scope, search);
  const samples = [];
  const pageSize = 100;
  const last = Math.max(0, Math.ceil(e.rows.length / pageSize) - 1);
  const pages = [
    0,
    Math.min(1, last),
    Math.floor(last / 2),
    Math.max(0, last - 1),
    last,
  ];
  for (let wave = 0; wave < 5; wave++) {
    const settled = await Promise.allSettled(
      pages.map(async (pageIndex) => {
        const start = performance.now();
        const data = ok(
          await actor.client.rpc("list_bids_v2", {
            p_query: {
              search,
              scopeBidderId: scope ?? undefined,
              rangeFrom: range.from,
              rangeTo: range.to,
              pageIndex,
              pageSize,
              sorting: [sort],
            },
          }),
        );
        const duration = performance.now() - start;
        validate(data, e, actor, pageIndex, pageSize, checkFeature);
        samples.push(duration);
      }),
    );
    // Wait for every reader before cleanup, even when a sibling fails.
    for (const result of settled)
      if (result.status === "rejected") throw result.reason;
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  const measurement = {
    role: actor.role,
    range: range.name,
    scope: label,
    sort: sort.id,
    descending: sort.desc,
    samples: samples.length,
    concurrency: 5,
    p95Ms: p95,
    maxMs: Math.round(samples.at(-1)),
    passed: p95 < 2000,
  };
  results.push(measurement);
  receipt.results = results;
  await save();
  console.log(JSON.stringify(measurement));
}

async function verifyCleanupScope() {
  validateReceipt(receipt);
  const users = receipt.accounts.map((a) => a.id);
  for (const planned of receipt.accounts) {
    const response = await service.auth.admin.getUserById(planned.id);
    if (response.error) {
      assert.ok(
        response.error.status === 404 ||
          response.error.code === "user_not_found",
        "Cannot prove synthetic Auth ownership",
      );
    } else
      assert.equal(
        response.data.user.email,
        planned.email,
        "Auth identity is not this fixture",
      );
  }
  const people = ok(
    await service.from("profiles").select("id,email").in("id", users),
  );
  for (const person of people)
    assert.equal(
      person.email,
      receipt.accounts.find((a) => a.id === person.id)?.email,
      "Profile is not this fixture",
    );
  const owned = ok(
    await service
      .from("workspaces")
      .select("id,owner_id")
      .in("owner_id", users),
  );
  const known = receipt.workspaceIds.length
    ? ok(
        await service
          .from("workspaces")
          .select("id,owner_id")
          .in("id", receipt.workspaceIds),
      )
    : [];
  for (const workspace of known)
    assert.ok(
      users.includes(workspace.owner_id),
      "Receipt names a foreign workspace",
    );
  receipt.workspaceIds = [
    ...new Set([...receipt.workspaceIds, ...owned.map((w) => w.id)]),
  ];
  await save();
  const ws = receipt.workspaceIds;
  // Fail closed if another actor or unmarked data entered a synthetic workspace.
  if (ws.length) {
    for (const [table, column] of [
      ["bids", "company"],
      ["files", "storage_path"],
      ["resumes", "identifier"],
      ["candidate_profiles", "identifier"],
    ]) {
      const response = await service
        .from(table)
        .select(column, { count: "exact", head: true })
        .in("workspace_id", ws)
        .not(column, "like", `${receipt.marker}%`);
      ok(response);
      assert.equal(response.count, 0, "Foreign data found in synthetic scope");
    }
    const memberships = ok(
      await service.from("bidders").select("user_id").in("workspace_id", ws),
    );
    for (const row of memberships)
      assert.ok(
        users.includes(row.user_id),
        "Foreign membership in synthetic scope",
      );
  }
  const provisions = ok(
    await service.from("client_provisions").select("id,email").in("id", users),
  );
  for (const row of provisions)
    assert.equal(
      row.email,
      receipt.accounts.find((a) => a.id === row.id)?.email,
      "Foreign provision identity",
    );
  const externalEvents = await service
    .from("account_events")
    .select("id", { count: "exact", head: true })
    .in("actor_id", users)
    .not("account_id", "in", `(${users.join(",")})`);
  ok(externalEvents);
  assert.equal(
    externalEvents.count,
    0,
    "Synthetic actor referenced by foreign account event",
  );
  return { users, ws };
}
async function cleanup() {
  receipt.cleanupComplete = false;
  receipt.phase = "cleanup:validate";
  await save();
  const { users, ws } = await verifyCleanupScope();
  const count = async (table, column, ids) => {
    if (!ids.length) return 0;
    const response = await service
      .from(table)
      .select(column, { count: "exact", head: true })
      .in(column, ids);
    ok(response);
    return response.count;
  };
  const remove = async (table, column, ids) => {
    if (ids.length) ok(await service.from(table).delete().in(column, ids));
  };
  const scopedIds = async (table) => {
    const ids = [];
    for (let offset = 0; ws.length; offset += 1000) {
      const rows = ok(
        await service
          .from(table)
          .select("id")
          .in("workspace_id", ws)
          .order("id")
          .range(offset, offset + 999),
      );
      ids.push(...rows.map((row) => row.id));
      if (rows.length < 1000) break;
    }
    return ids;
  };
  const bidIds = await scopedIds("bids"),
    fileIds = await scopedIds("files");
  // Keep IN URLs small and individual FK mutations below hosted deadlines.
  const cleanupChunks = (ids, operation) => chunks(ids, operation, 100);
  // Circular bids/files + resume/files FKs: events, pointers, files, bids.
  receipt.phase = "cleanup:evidence";
  await save();
  await cleanupChunks(bidIds, (ids) => remove("bid_events", "bid_id", ids));
  if (ws.length) {
    await cleanupChunks(bidIds, async (ids) =>
      ok(
        await service
          .from("bids")
          .update({
            evidence_file_id: null,
            applied: false,
            application_method: null,
          })
          .in("id", ids),
      ),
    );
    ok(
      await service
        .from("resumes")
        .update({ file_id: null })
        .in("workspace_id", ws),
    );
    await cleanupChunks(fileIds, (ids) => remove("files", "id", ids));
    await cleanupChunks(bidIds, (ids) => remove("bids", "id", ids));
    for (const table of [
      "retained_bid_daily_aggregates",
      "resumes",
      "candidate_profiles",
      "invitations",
      "bidders",
    ])
      await remove(table, "workspace_id", ws);
  }
  receipt.phase = "cleanup:accounts";
  await save();
  await remove("client_provisions", "id", users);
  await remove("account_events", "account_id", users);
  await remove("account_events", "actor_id", users);
  await remove("inbox_notifications", "client_id", users);
  await remove("inbox_notifications", "user_id", users);
  await remove("workspaces", "id", ws);
  ok(
    await service
      .from("profiles")
      .update({ reviewed_by: null })
      .in("id", users),
  );
  await remove("profiles", "id", users);
  for (const id of users) {
    const response = await service.auth.admin.deleteUser(id);
    if (
      response.error &&
      !(
        response.error.status === 404 ||
        response.error.code === "user_not_found"
      )
    )
      ok(response);
  }
  const counts = {};
  for (const table of [
    "files",
    "bids",
    "retained_bid_daily_aggregates",
    "resumes",
    "candidate_profiles",
    "invitations",
    "bidders",
  ])
    counts[table] = await count(table, "workspace_id", ws);
  for (const table of ["workspaces", "profiles", "client_provisions"])
    counts[table] = await count(
      table,
      "id",
      table === "workspaces" ? ws : users,
    );
  counts.bid_events = 0;
  await cleanupChunks(bidIds, async (ids) => {
    counts.bid_events += await count("bid_events", "bid_id", ids);
  });
  counts.account_events =
    (await count("account_events", "account_id", users)) +
    (await count("account_events", "actor_id", users));
  counts.inbox_notifications =
    (await count("inbox_notifications", "client_id", users)) +
    (await count("inbox_notifications", "user_id", users));
  counts.authUsers = 0;
  for (const id of users) {
    const response = await service.auth.admin.getUserById(id);
    if (!response.error) counts.authUsers++;
    else
      assert.ok(
        response.error.status === 404 ||
          response.error.code === "user_not_found",
      );
  }
  receipt.cleanupCounts = counts;
  assert.ok(
    Object.values(counts).every((n) => n === 0),
    "Cleanup must leave zero residual fixture data",
  );
  receipt.cleanupComplete = true;
  receipt.fixtureRetained = false;
  receipt.phase = "cleaned";
  await save();
}
async function main() {
  const planOnly = args.includes("--plan-only");
  const usePlan = option("--use-plan");
  assert.equal(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    STAGING,
    "Dedicated staging only",
  );
  assert.ok(
    args.includes("--staging-ready"),
    "Explicit --staging-ready required before writes or recovery",
  );
  assert.ok(
    !(before && recovery),
    "--before and --cleanup-only are mutually exclusive",
  );
  assert.ok(
    !(keep && (before || recovery)),
    "--keep-fixture is allowed only for a passed post-migration benchmark",
  );
  assert.ok(
    !(planOnly && (before || recovery || keep || usePlan)),
    "Plan creation is post-mode only and cannot write, retain or recover",
  );
  assert.ok(
    !(usePlan && (before || recovery || option("--receipt"))),
    "Use a fresh post plan as the execution receipt",
  );
  if (!planOnly)
    assert.ok(
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY &&
        process.env.SUPABASE_SECRET_KEY,
      "Staging keys required",
    );
  for (let index = 0; index < args.length; index++) {
    assert.ok(
      [
        "--before",
        "--cleanup-only",
        "--staging-ready",
        "--receipt",
        "--keep-fixture",
        "--plan-only",
        "--use-plan",
      ].includes(args[index]),
      "Unsupported flag",
    );
    if (["--receipt", "--use-plan"].includes(args[index])) index++;
  }
  if (!planOnly)
    service = createClient(STAGING, process.env.SUPABASE_SECRET_KEY, options);
  if (recovery) {
    assert.ok(option("--receipt"), "Recovery requires explicit --receipt");
    receiptPath = guardedPath(option("--receipt"));
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    validateReceipt(receipt);
    await cleanup();
    return;
  }
  const planBytes = usePlan ? await readFile(guardedPath(usePlan), "utf8") : null;
  const planned = planBytes ? JSON.parse(planBytes) : null;
  if (planned) assertFreshPlan(planned, validateReceipt);
  const marker = planned?.marker ?? `${PREFIX}${randomUUID()}`;
  receiptPath = guardedPath(
    usePlan ??
      option("--receipt") ??
      `.superpowers/sdd/2026-10-12-screenshot-size-matching/hosted-receipts/${marker}-${before ? "before" : "after"}.json`,
  );
  receipt = planned ?? {
    version: 1,
    target: STAGING,
    marker,
    mode: before ? "before" : "after",
    createdAt: new Date().toISOString(),
    fixtureBids: 25000,
    accounts: LABELS.map((label) => ({
      label,
      id: randomUUID(),
      email: `${marker}-${label}@example.com`,
    })),
    workspaceIds: [],
    results,
    phase: "planned",
    passed: false,
    cleanupComplete: false,
  };
  validateReceipt(receipt);
  // Never overwrite a previous receipt, and persist all planned Auth IDs before the first write.
  if (!planned) await save(true);
  if (planOnly) {
    console.log(
      JSON.stringify({
        planned: true,
        receipt: path.relative(process.cwd(), receiptPath),
      }),
    );
    return;
  }
  if (planned) {
    await verifyUnusedPlan(service, planned, ok);
    await claimPlan(receiptPath, planBytes);
  }
  receipt.started = true;
  await save();
  const sponsor = ok(
    await service
      .from("profiles")
      .select("id")
      .eq("role", "admin")
      .eq("archived", false)
      .eq("approval_status", "approved")
      .limit(1),
  );
  assert.equal(
    sponsor.length,
    1,
    "An existing admin provisioning sponsor is required; no public signup fallback",
  );
  const actors = {};
  actors.owner = await account(receipt.accounts[0], "client", sponsor[0].id);
  for (const [index, role] of [
    [1, "admin"],
    [2, "bidder"],
    [3, "bidder"],
    [4, "bidder"],
  ]) {
    actors[LABELS[index]] = await account(
      receipt.accounts[index],
      role,
      actors.owner.id,
    );
  }
  const alerts = await service
    .from("inbox_notifications")
    .select("id", { count: "exact", head: true })
    .in(
      "client_id",
      receipt.accounts.map((a) => a.id),
    );
  ok(alerts);
  assert.equal(
    alerts.count,
    0,
    "Synthetic provisioning must not create signup alerts or pushes",
  );
  receipt.signupNotificationCount = alerts.count;
  const today = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
  fixtureData = fixture(actors, marker, today);
  receipt.fixtureFiles = fixtureData.files.length;
  receipt.phase = "seed";
  await save();
  ok(
    await service.from("bidders").insert(
      [actors.bidder1, actors.bidder2, actors.outsider].map((actor, index) => ({
        user_id: actor.id,
        workspace_id:
          index === 2 ? actors.admin.workspace : actors.owner.workspace,
        default_rate_cents: 100,
      })),
    ),
  );
  ok(
    await service.from("candidate_profiles").insert(
      fixtureData.assignments.map((row) => ({
        id: row.profile_id,
        workspace_id: row.workspace_id,
        identifier: row.identifier,
        candidate_name: row.candidate_name,
        retention_months: null,
      })),
    ),
  );
  ok(await service.from("resumes").insert(fixtureData.assignments));
  await chunks(fixtureData.bids, (rows) =>
    seed("bids", "insert", rows.map((row) => ({ ...row, evidence_file_id: null }))),
  );
  await chunks(fixtureData.files, (rows) =>
    seed("files", "insert", rows),
  );
  await chunks(fixtureData.finalBids, (rows) =>
    seed("bids", "upsert", rows),
  );
  const seeded = await service
    .from("bids")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", actors.owner.workspace);
  ok(seeded);
  assert.equal(seeded.count, 25000);
  const ranges = [
    { name: "all", from: null, to: null },
    {
      name: "recent",
      from: fromZonedTime(
        `${shift(today, -29)}T00:00:00`,
        "America/Chicago",
      ).toISOString(),
      to: fromZonedTime(
        `${shift(today, 1)}T00:00:00`,
        "America/Chicago",
      ).toISOString(),
    },
  ];
  receipt.ranges = ranges;
  receipt.phase = "benchmark";
  await save();
  const sorts = [
    { id: "found_at", desc: true },
    ...(!before
      ? [
          { id: "screenshot_size_bytes", desc: false },
          { id: "screenshot_size_bytes", desc: true },
        ]
      : []),
  ];
  for (const actor of [actors.owner, actors.admin, actors.bidder1])
    for (const range of ranges)
      for (const sort of sorts)
        await benchmark(actor, range, sort, null, `${marker}-main-`, !before);
  if (!before) {
    await benchmark(
      actors.admin,
      ranges[0],
      sorts[1],
      null,
      marker,
      true,
      "authorized-cross-workspace",
    );
    await benchmark(
      actors.owner,
      ranges[0],
      sorts[1],
      actors.bidder2.id,
      marker,
      true,
      "filtered-bidder",
    );
    await benchmark(
      actors.owner,
      ranges[0],
      { id: "screenshot", desc: true },
      null,
      `${marker}-main-`,
      true,
      "presence-sort",
    );
  }
  // Real RLS sessions: forced scope to another workspace/bidder stays empty.
  for (const [actor, foreign] of [
    [actors.owner, actors.outsider],
    [actors.bidder1, actors.bidder2],
  ]) {
    const data = ok(
      await actor.client.rpc("list_bids_v2", {
        p_query: { search: marker, scopeBidderId: foreign.id },
      }),
    );
    assert.equal(data.total, 0);
    assert.deepEqual(data.rows, []);
  }
  for (const actor of [actors.owner, actors.admin, actors.bidder1]) {
    const denied = await actor.client
      .from("bids")
      .select("rate_cents")
      .limit(1);
    assert.equal(denied.error?.code, "42501");
  }
  assert.ok(
    results.every((measurement) => measurement.passed),
    "p95 must be below 2000ms",
  );
  receipt.passed = true;
  receipt.fixtureRetained = keep;
  await save();
}
function selfTest() {
  const marker = `${PREFIX}${randomUUID()}`;
  const sample = {
    version: 1,
    target: STAGING,
    marker,
    mode: "before",
    fixtureBids: 25000,
    accounts: LABELS.map((label) => ({
      label,
      id: randomUUID(),
      email: `${marker}-${label}@example.com`,
    })),
    workspaceIds: [],
  };
  validateReceipt(sample);
  assert.throws(() =>
    validateReceipt({ ...sample, target: "https://example.invalid" }),
  );
  assert.throws(() => validateReceipt({ ...sample, marker: "customer-scope" }));
  assert.throws(() =>
    validateReceipt({
      ...sample,
      accounts: sample.accounts.map((a, index) => ({
        ...a,
        email: index ? a.email : "real@example.com",
      })),
    }),
  );
  assert.throws(() =>
    validateReceipt({
      ...sample,
      accounts: sample.accounts.map((a) => ({
        ...a,
        id: sample.accounts[0].id,
      })),
    }),
  );
  assert.throws(() => guardedPath("../foreign.json"));
  assert.throws(() => guardedPath(".superpowers/../../foreign.json"));
  assert.throws(() => guardedPath(".superpowers/receipt.txt"));
  assert.equal(
    guardedPath(".superpowers/check.json"),
    path.resolve(".superpowers/check.json"),
  );
  console.log(
    "PASS: receipt identity, target, uniqueness, and path guards (no hosted calls or environment reads)",
  );
}
if (args.includes("--self-test")) {
  assert.deepEqual(args, ["--self-test"]);
  selfTest();
} else {
  try {
    await main();
  } catch (error) {
    failed = true;
    if (receipt?.started || (recovery && receipt)) {
      receipt.passed = false;
      receipt.failure = {
        code: error.code ?? error.name,
        phase: receipt.phase,
      };
      await save().catch(() => {});
    }
    console.error(
      JSON.stringify({
        passed: false,
        code: error.code ?? error.name,
        phase: receipt?.phase ?? "configuration",
      }),
    );
  } finally {
    for (const client of sessions)
      await client.auth.signOut({ scope: "local" }).catch(() => {});
    if (receipt?.started && !recovery && !(keep && receipt.passed && !failed)) {
      try {
        await cleanup();
      } catch (error) {
        failed = true;
        receipt.cleanupComplete = false;
        receipt.cleanupError = {
          code: error.code ?? error.name,
          phase: receipt.phase,
        };
        await save().catch(() => {});
      }
    }
    if (receiptPath && (receipt?.started || recovery))
      console.log(
        JSON.stringify({
          passed: receipt?.passed ?? false,
          cleanupComplete: receipt?.cleanupComplete ?? false,
          fixtureRetained:
            !!receipt?.fixtureRetained && !receipt?.cleanupComplete,
          receipt: path.relative(process.cwd(), receiptPath),
        }),
      );
  }
  if (failed) process.exitCode = 1;
}
