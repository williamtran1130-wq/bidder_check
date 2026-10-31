// Guarded, synthetic-only staging acceptance. No storage objects are uploaded.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { performance as defaultPerformance } from "node:perf_hooks";
import { createClient as defaultCreateClient } from "@supabase/supabase-js";
import {
  formatInTimeZone as defaultFormatInTimeZone,
  fromZonedTime as defaultFromZonedTime,
} from "date-fns-tz";
import { seedChunk } from "./screenshot-size-seed-reconciliation.mjs";
import {
  assertFreshPlan,
  verifyUnusedPlan,
  claimPlan,
} from "./screenshot-size-benchmark-plan.mjs";

import {
  STAGING as DEFAULT_STAGING,
  PREFIX,
  LABELS,
  P95_LIMIT_MS,
  validateReceipt as defaultValidateReceipt,
  shift as defaultShift,
  fixture as defaultFixture,
  expected as defaultExpected,
  validate as defaultValidate,
  buildBenchmarkMatrix,
} from "./screenshot-size-benchmark-helpers.mjs";

export function createBenchmarkRunner(dependencies = {}) {
  const process = dependencies.process ?? globalThis.process;
  const console = dependencies.console ?? globalThis.console;
  const createClient = dependencies.createClient ?? defaultCreateClient;
  const performance = dependencies.performance ?? defaultPerformance;
  const setTimeout = dependencies.setTimeout ?? globalThis.setTimeout;
  const STAGING = dependencies.target ?? DEFAULT_STAGING;
  const formatInTimeZone =
    dependencies.formatInTimeZone ?? defaultFormatInTimeZone;
  const fromZonedTime = dependencies.fromZonedTime ?? defaultFromZonedTime;
  const shift = dependencies.shift ?? defaultShift;
  const fixture = dependencies.fixture ?? defaultFixture;
  const expected = dependencies.expected ?? defaultExpected;
  const validateReceipt =
    dependencies.validateReceipt ??
    ((value) => defaultValidateReceipt(value, STAGING));
  const validate =
    dependencies.validate ??
    ((...args) => defaultValidate(...args, fixtureData));
  const args = dependencies.args ?? process.argv.slice(2);
  const before = args.includes("--before");
  const recovery = args.includes("--cleanup-only");
  const keep = args.includes("--keep-fixture");
  const results = [];
  const sessions = [];
  let service, receipt, receiptPath;
  let failed = false;
  let diagnosticHoldSeconds = 0;

  function option(name) {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    assert.ok(
      args[index + 1] && !args[index + 1].startsWith("--"),
      `Value required for ${name}`,
    );
    return args[index + 1];
  }
  function defaultGuardedPath(value) {
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
  async function defaultSave(initial = false) {
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
  function defaultOk(response) {
    if (response.error) {
      const error = new Error("Hosted operation failed (details withheld)");
      error.code = response.error.code ?? response.error.status ?? "unknown";
      throw error;
    }
    return response.data;
  }
  async function defaultChunks(rows, action, size = 500) {
    for (let start = 0; start < rows.length; start += size)
      await action(rows.slice(start, start + size));
  }
  function seed(table, operation, rows) {
    return seedChunk({
      service,
      receipt,
      table,
      operation,
      rows,
      check: ok,
      save,
    });
  }
  async function defaultAccount(planned, role, sponsor) {
    // Managed provisioning creates approved synthetic accounts.
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
        user_metadata: {
          display_name: `Screenshot benchmark ${planned.label}`,
        },
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
    ok(
      await client.auth.signInWithPassword({ email: planned.email, password }),
    );
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
  let fixtureData;
  async function benchmark(
    actor,
    range,
    sort,
    scope,
    search,
    checkFeature,
    label = "main",
    mode = {},
  ) {
    const e = expected(fixtureData, actor, range, sort, scope, search, mode);
    const samples = [];
    const requests = [];
    // Never include provider messages/details, identities, or query values.
    const diagnosticCode = (error) => {
      const code = String(error?.code ?? "");
      return /^(?:[0-9A-Z]{5}|PGRST\d{3}|ERR_ASSERTION|[1-5]\d{2})$/.test(code)
        ? code
        : "UNKNOWN";
    };
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
      const waveRequests = new Array(pages.length);
      const settled = await Promise.allSettled(
        pages.map(async (pageIndex, reader) => {
          const start = performance.now();
          let duration;
          try {
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
                  status: mode.status ?? "all",
                  arrangement: mode.arrangement,
                  columnFilters: {
                    screenshot: mode.repeated ? "Repeated sizes only" : "",
                  },
                },
              }),
            );
            duration = performance.now() - start;
            validate(data, e, actor, pageIndex, pageSize, checkFeature);
            samples.push(duration);
            waveRequests[reader] = {
              wave: wave + 1,
              reader: reader + 1,
              pageIndex,
              durationMs: duration,
              errorCode: null,
            };
          } catch (error) {
            waveRequests[reader] = {
              wave: wave + 1,
              reader: reader + 1,
              pageIndex,
              durationMs: duration ?? performance.now() - start,
              errorCode: diagnosticCode(error),
            };
            throw error;
          }
        }),
      );
      // Wait for every reader before cleanup, even when a sibling fails.
      requests.push(...waveRequests);
      for (const result of settled)
        if (result.status === "rejected") {
          receipt.benchmarkFailure = {
            caseNumber: results.length + 1,
            role: actor.role,
            range: range.name,
            scope: label,
            sort: sort.id,
            descending: sort.desc,
            mode: mode.repeated ? "repeated" : "ordinary",
            status: mode.status ?? "all",
            wave: wave + 1,
            requests,
          };
          // Best effort here, then the existing failure handler retries save
          // before cleanup. Preserve the original first reader rejection.
          await save().catch(() => {});
          throw result.reason;
        }
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    const measurement = {
      matrixKind: receipt.matrixKind,
      role: actor.role,
      range: range.name,
      scope: label,
      sort: sort.id,
      descending: sort.desc,
      screenshotFilter: mode.repeated ? "Repeated sizes only" : "",
      status: mode.status ?? "all",
      arrangement: mode.arrangement ?? null,
      samples: samples.length,
      concurrency: 5,
      p95LimitMs: P95_LIMIT_MS,
      p95Ms: p95,
      maxMs: Math.round(samples.at(-1)),
      passed: p95 < P95_LIMIT_MS,
      requests,
    };
    results.push(measurement);
    receipt.results = results;
    await save();
    console.log(JSON.stringify(measurement));
  }

  async function diagnosticHold() {
    if (
      !diagnosticHoldSeconds ||
      !receipt?.started ||
      recovery ||
      receipt.failure?.phase !== "benchmark"
    )
      return;
    const previousPhase = receipt.phase;
    receipt.phase = "diagnostic-hold";
    const start = performance.now();
    const deadline = start + diagnosticHoldSeconds * 1000;
    const wallStart = Date.now();
    const hold = {
      seconds: diagnosticHoldSeconds,
      startedAt: new Date(wallStart).toISOString(),
      expiresAt: new Date(
        wallStart + diagnosticHoldSeconds * 1000,
      ).toISOString(),
      completed: false,
    };
    receipt.diagnosticHold = hold;
    try {
      await save();
    } catch {
      hold.skipped = true;
      receipt.phase = previousPhase;
      return;
    }
    const update = (remainingSeconds) =>
      console.log(
        JSON.stringify({
          diagnosticHold: true,
          phase: "diagnostic-hold",
          remainingSeconds,
        }),
      );
    update(diagnosticHoldSeconds);
    try {
      for (;;) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(30000, remaining)),
        );
        update(Math.max(0, Math.ceil((deadline - performance.now()) / 1000)));
      }
    } finally {
      hold.completed = true;
      hold.elapsedMs = performance.now() - start;
      receipt.phase = previousPhase;
      await save().catch(() => {});
    }
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
        assert.equal(
          response.count,
          0,
          "Foreign data found in synthetic scope",
        );
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
      await service
        .from("client_provisions")
        .select("id,email")
        .in("id", users),
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
  async function defaultCleanup() {
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
    const ordinaryOnly = args.includes("--ordinary-only");
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
      !(ordinaryOnly && before),
      "--ordinary-only and --before are mutually exclusive",
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
          "--representative-bids",
          "--ordinary-only",
          "--diagnostic-hold-seconds",
        ].includes(args[index]),
        "Unsupported flag",
      );
      if (
        [
          "--receipt",
          "--use-plan",
          "--representative-bids",
          "--diagnostic-hold-seconds",
        ].includes(args[index])
      )
        index++;
    }
    const holdSeconds = option("--diagnostic-hold-seconds") ?? "0";
    assert.ok(
      /^\d+$/.test(holdSeconds) &&
        Number(holdSeconds) <= 120 &&
        args.filter((arg) => arg === "--diagnostic-hold-seconds").length <= 1,
      "Diagnostic hold must be one integer from 0 through 120 seconds",
    );
    diagnosticHoldSeconds = Number(holdSeconds);
    const representative =
      !planOnly && !recovery ? option("--representative-bids") : null;
    if (!planOnly && !recovery) {
      assert.ok(
        typeof representative === "string" && /^[1-9]\d*$/.test(representative),
        "Execution requires a positive integer --representative-bids",
      );
      assert.ok(
        Number.isSafeInteger(Number(representative)),
        "Representative count must be a safe integer",
      );
      assert.ok(
        Number(representative) <= Math.floor(25000 / 2),
        "25,000 fixture bids must be at least twice representative volume",
      );
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
    const planBytes = usePlan
      ? await readFile(guardedPath(usePlan), "utf8")
      : null;
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
    receipt.p95LimitMs = P95_LIMIT_MS;
    receipt.matrixKind = ordinaryOnly ? "ordinary-baseline" : "full";
    receipt.representativeBids = Number(representative);
    receipt.fixtureVolumeMultiple =
      receipt.fixtureBids / receipt.representativeBids;
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
    const today = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
    fixtureData = fixture(actors, marker, today);
    receipt.fixtureFiles = fixtureData.files.length;
    receipt.phase = "seed";
    await save();
    ok(
      await service.from("bidders").insert(
        [actors.bidder1, actors.bidder2, actors.outsider].map(
          (actor, index) => ({
            user_id: actor.id,
            workspace_id:
              index === 2 ? actors.admin.workspace : actors.owner.workspace,
            default_rate_cents: 100,
          }),
        ),
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
      seed(
        "bids",
        "insert",
        rows.map((row) => ({ ...row, evidence_file_id: null })),
      ),
    );
    await chunks(fixtureData.files, (rows) => seed("files", "insert", rows));
    await chunks(fixtureData.finalBids, (rows) => seed("bids", "upsert", rows));
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
    for (const args of buildBenchmarkMatrix({
      actors,
      ranges,
      marker,
      before,
      ordinaryOnly,
    }))
      await benchmark(...args);
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
      `p95 must be below ${P95_LIMIT_MS}ms`,
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
    assert.throws(() =>
      validateReceipt({ ...sample, marker: "customer-scope" }),
    );
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

  const save = dependencies.save ?? defaultSave;
  const account = dependencies.account ?? defaultAccount;
  const chunks = dependencies.chunks ?? defaultChunks;
  const ok = dependencies.ok ?? defaultOk;
  const cleanup = dependencies.cleanup ?? defaultCleanup;
  const guardedPath = dependencies.guardedPath ?? defaultGuardedPath;
  if (dependencies.sessions) sessions.push(...dependencies.sessions);
  return {
    get receipt() {
      return receipt;
    },
    get results() {
      return results;
    },
    async run() {
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
              benchmark: receipt?.benchmarkFailure,
            }),
          );
          // External read-only plan capture may use this explicit bounded window.
          // Never retain a failed fixture or bypass the existing cleanup finally.
          await diagnosticHold().catch(() => {});
        } finally {
          for (const client of sessions)
            await client.auth.signOut({ scope: "local" }).catch(() => {});
          if (
            receipt?.started &&
            !recovery &&
            !(keep && receipt.passed && !failed)
          ) {
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
    },
  };
}
