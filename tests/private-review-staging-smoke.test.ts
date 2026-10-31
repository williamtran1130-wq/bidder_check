import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it, vi } from "vitest";

const smoke = await import("../scripts/private-review-staging-smoke.mjs");
const target = "https://kdmvludtvhuuewmhurpw.supabase.co";
const marker = "screenshot-size-bench-70000000-0000-4000-8000-000000000000";
const labels = ["owner", "admin", "bidder1", "bidder2", "outsider"];
const roles = ["client", "admin", "bidder"];
function receipt() {
  const results: Record<string, unknown>[] = [];
  const add = (role: string, range: string, sort: string, descending: boolean, screenshotFilter = "", scope = "main", status = "all", arrangement: string | null = null) => results.push({ matrixKind: "full", role, range, scope, sort, descending, screenshotFilter, status, arrangement, concurrency: 5, samples: 15, p95LimitMs: 10000, p95Ms: 125, maxMs: 180, passed: true });
  const sorts: [string, boolean][] = [["found_at", true], ["screenshot_size_bytes", false], ["screenshot_size_bytes", true]];
  for (const role of roles) for (const range of ["all", "recent"]) for (const [sort, descending] of sorts) { add(role, range, sort, descending); add(role, range, sort, descending, "Repeated sizes only"); }
  add("admin", "all", "screenshot_size_bytes", false, "", "authorized-cross-workspace");
  add("client", "all", "screenshot_size_bytes", false, "", "filtered-bidder");
  add("client", "all", "screenshot", true, "", "presence-sort");
  for (const role of ["client", "admin"]) for (const status of ["applied", "unapplied", "pending_review"]) for (const descending of [false, true]) add(role, "all", "screenshot_size_bytes", descending, "Repeated sizes only", "main", status);
  for (const descending of [false, true]) { add("admin", "all", "screenshot_size_bytes", descending, "Repeated sizes only", "authorized-cross-workspace"); add("client", "all", "screenshot_size_bytes", descending, "Repeated sizes only", "filtered-bidder"); add("client", "recent", "screenshot_size_bytes", descending, "Repeated sizes only", "filtered-arrangement", "all", "remote"); }
  return { version: 1, target, marker, mode: "after", fixtureBids: 25000, fixtureRetained: true, cleanupComplete: false, passed: true, matrixKind: "full", representativeBids: 12000, fixtureVolumeMultiple: 25000 / 12000, p95LimitMs: 10000, accounts: labels.map((label, index) => ({ label, id: `70000000-0000-4000-8000-00000000000${index + 1}`, email: `${marker}-${label}@example.com` })), workspaceIds: labels.map((_, index) => `70000000-0000-4000-8000-00000000001${index + 1}`), results };
}
const config = { target, publishableKey: "fixture-public", secretKey: "fixture-secret", args: ["--staging-ready", "--receipt", ".superpowers/passed.json", "--output", ".superpowers/private.json"] };
it("accepts only an explicitly armed exact staging target and guarded independent receipts", () => {
  expect(smoke.validateConfiguration(config)).toMatchObject({ keep: false, recovery: false });
  expect(smoke.guardedPath(".superpowers/private.json")).toBe(path.resolve(".superpowers/private.json"));
  for (const target of ["https://aizorlyfggwbewetnwqm.supabase.co", "https://kdmvludtvhuuewmhurpw.supabase.co.attacker.test", `${config.target}/`, "http://kdmvludtvhuuewmhurpw.supabase.co"]) expect(() => smoke.validateConfiguration({ ...config, target })).toThrow();
  for (const args of [config.args.filter((arg) => arg !== "--staging-ready"), [...config.args, "--production"], ["--staging-ready", "--receipt", ".superpowers/a.json", "--output", ".superpowers/a.json"], [...config.args, "--keep-fixture", "--cleanup-only"]]) expect(() => smoke.validateConfiguration({ ...config, args })).toThrow();
  for (const value of [".superpowers/../outside.json", ".superpowers", ".superpowers/private.txt"]) expect(() => smoke.guardedPath(value)).toThrow();
});
it("requires a retained passed full57 matrix at five readers and twice representative volume", () => {
  const full = receipt(); expect(full.results).toHaveLength(57); expect(smoke.validateBenchmarkReceipt(full)).toBeUndefined();
  const mutations = [
    { target: "https://production.invalid" }, { mode: "before" }, { passed: false }, { fixtureRetained: false }, { cleanupComplete: true }, { matrixKind: "ordinary-baseline" }, { representativeBids: 12501 }, { fixtureVolumeMultiple: 1 },
    { results: full.results.slice(1) }, { results: full.results.map((row, index) => index ? row : { ...row, p95Ms: 10000 }) }, { results: full.results.map((row, index) => index ? row : { ...row, concurrency: 1 }) },
    { results: full.results.map((row, index) => index ? row : { ...row, matrixKind: "ordinary-baseline" }) }, { results: full.results.map((row, index) => index ? row : { ...row, passed: false }) }, { results: full.results.map(() => full.results[0]) },
    { accounts: full.accounts.map((account, index) => index ? account : { ...account, email: "real@example.com" }) }, { accounts: full.accounts.map((account) => ({ ...account, id: full.accounts[0].id })) }, { workspaceIds: ["foreign"] },
  ];
  for (const patch of mutations) expect(() => smoke.validateBenchmarkReceipt({ ...receipt(), ...patch })).toThrow();
});
function fixtureService(full = receipt(), mismatch: "auth" | "profile" | "workspace" | "membership" | "assignment" | null = null) {
  const rows: Record<string, unknown[]> = {
    profiles: full.accounts.map((account, index) => ({ ...account, role: index < 2 ? ["client", "admin"][index] : "bidder", archived: false, approval_status: "approved" })),
    workspaces: full.workspaceIds.map((id, index) => ({ id, owner_id: full.accounts[index].id })),
    bidders: [{ user_id: full.accounts[2].id, workspace_id: full.workspaceIds[0], archived: false }],
    resumes: [{ id: "70000000-0000-4000-8000-000000000021", workspace_id: full.workspaceIds[0], bidder_id: full.accounts[2].id, identifier: `${full.marker}-0`, profile_id: "70000000-0000-4000-8000-000000000022", archived: false }],
    candidate_profiles: [{ id: "70000000-0000-4000-8000-000000000022", workspace_id: full.workspaceIds[0], identifier: `${full.marker}-0` }],
  };
  if (mismatch === "profile") (rows.profiles[0] as { email: string }).email = "foreign@example.com";
  if (mismatch === "workspace") (rows.workspaces[0] as { owner_id: string }).owner_id = full.accounts[4].id;
  if (mismatch === "membership") (rows.bidders[0] as { workspace_id: string }).workspace_id = full.workspaceIds[1];
  if (mismatch === "assignment") (rows.resumes[0] as { identifier: string }).identifier = "Foreign assignment";
  const table = (name: string) => {
    const response = { data: rows[name], count: rows[name]?.length ?? 0, error: null };
    const query = { select: () => query, in: () => query, eq: () => query, limit: () => query, then: (resolve: (value: typeof response) => unknown) => Promise.resolve(response).then(resolve) }; return query;
  };
  return { auth: { admin: { getUserById: vi.fn(async (id: string) => ({ data: { user: { id, email: mismatch === "auth" ? "foreign@example.com" : full.accounts.find((account) => account.id === id)?.email } }, error: null })) } }, from: table };
}
it("proves receipt actor, workspace, bidder, assignment ownership before any authentication or writes", async () => {
  const full = receipt();
  expect(await smoke.verifyFixtureOwnership(fixtureService(full), full)).toMatchObject({ workspaceId: full.workspaceIds[0], owner: { id: full.accounts[0].id }, bidder: { id: full.accounts[2].id } });
  for (const mismatch of ["auth", "profile", "workspace", "membership", "assignment"] as const) await expect(smoke.verifyFixtureOwnership(fixtureService(receipt(), mismatch), receipt())).rejects.toThrow();
});
function privateReceipt() {
  const full = receipt();
  return { version: 1, target, benchmarkPath: path.resolve(".superpowers/passed.json"), benchmarkMarker: marker, marker: `${marker}-private-70000000-0000-4000-8000-000000000030`, workspaceId: full.workspaceIds[0], ownerId: full.accounts[0].id, bidderId: full.accounts[2].id, assignmentId: "70000000-0000-4000-8000-000000000021", bidIds: ["70000000-0000-4000-8000-000000000031", "70000000-0000-4000-8000-000000000032"], fileIds: ["70000000-0000-4000-8000-000000000033", "70000000-0000-4000-8000-000000000034"], messageId: "70000000-0000-4000-8000-000000000035", counts: {}, cleanupComplete: false, fixtureRetained: true, phase: "passed" };
}
it("refuses private recovery receipts that change actors, source, planned IDs or scope", () => {
  const value = privateReceipt(); smoke.validatePrivateReceipt(value, receipt(), value.benchmarkPath);
  for (const patch of [{ target: "https://production.invalid" }, { benchmarkPath: "other" }, { ownerId: receipt().accounts[4].id }, { bidderId: receipt().accounts[3].id }, { marker: `${marker}-private-foreign` }, { fileIds: [value.fileIds[0], value.fileIds[0]] }, { bidIds: [...value.bidIds, randomUUID()] }, { workspaceId: "foreign" }]) expect(() => smoke.validatePrivateReceipt({ ...value, ...patch }, receipt(), value.benchmarkPath)).toThrow();
});
function cleanupService(value = privateReceipt(), foreign = false) {
  const effects: { table: string; method: string; filters: unknown[] }[] = [];
  const rows: Record<string, object[]> = {
    bids: value.bidIds.map((id, index) => ({ id, workspace_id: value.workspaceId, bidder_id: value.bidderId, resume_id: value.assignmentId, company: `${value.marker}-${index ? "ui" : "atomic"}` })),
    files: value.fileIds.map((id) => ({ id, workspace_id: value.workspaceId, bidder_id: value.bidderId, bid_id: value.bidIds[0], created_by: foreign ? receipt().accounts[4].id : value.ownerId, storage_path: `${value.marker}/${id}` })),
  };
  const service = { from: (table: string) => {
    let method = "select", head = false; const filters: unknown[] = [];
    const query = { select: (_columns?: unknown, options?: { head?: boolean }) => { head = !!options?.head; return query; }, delete: () => { method = "delete"; return query; }, update: () => { method = "update"; return query; }, in: (...args: unknown[]) => { filters.push(args); return query; }, eq: (...args: unknown[]) => { filters.push(args); return query; }, then: (resolve: (value: { data: object[]; count: number; error: null }) => unknown) => { if (method !== "select") effects.push({ table, method, filters }); return Promise.resolve({ data: head ? [] : rows[table] ?? [], count: 0, error: null }).then(resolve); } }; return query;
  } };
  return { service, effects };
}
it("verifies ownership and persists cleanup intent before touching only planned rows", async () => {
  const value = privateReceipt(), fixture = cleanupService(value), phases: string[] = [];
  await smoke.cleanupOwnedResources(fixture.service, value, async () => { phases.push(value.phase); if (phases.length === 1) expect(fixture.effects).toHaveLength(0); });
  expect(phases).toEqual(["cleanup", "cleaned"]); expect(value.cleanupComplete).toBe(true); expect(value.fixtureRetained).toBe(false);
  expect(fixture.effects).toEqual([
    { table: "bid_events", method: "delete", filters: [["bid_id", value.bidIds]] },
    { table: "bids", method: "update", filters: [["id", value.bidIds], ["workspace_id", value.workspaceId]] },
    { table: "files", method: "delete", filters: [["id", value.fileIds], ["workspace_id", value.workspaceId]] },
    { table: "bids", method: "delete", filters: [["id", value.bidIds], ["workspace_id", value.workspaceId]] },
  ]);
  const foreign = cleanupService(privateReceipt(), true); await expect(smoke.cleanupOwnedResources(foreign.service, privateReceipt(), async () => {})).rejects.toThrow(); expect(foreign.effects).toHaveLength(0);
  const blocked = cleanupService(); await expect(smoke.cleanupOwnedResources(blocked.service, privateReceipt(), async () => { throw new Error("Persistence unavailable"); })).rejects.toThrow(); expect(blocked.effects).toHaveLength(0);
});
it("creates durable private receipts exclusively and replaces only its own prior receipt", async () => {
  const file = smoke.guardedPath(`.superpowers/private-smoke-unit-${randomUUID()}.json`);
  try {
    await smoke.savePrivateReceipt(file, { phase: "planned", synthetic: true }, true);
    await expect(smoke.savePrivateReceipt(file, { phase: "overwrite" }, true)).rejects.toThrow();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ phase: "planned", synthetic: true });
    await smoke.savePrivateReceipt(file, { phase: "cleanup", synthetic: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ phase: "cleanup", synthetic: true });
  } finally { await rm(file, { force: true }); }
});
it("rejects hosted finalizer transports outside the exact staging RPC before network access", async () => {
  const transport = smoke.isolatedServiceFetch(undefined);
  await expect(transport("https://production.invalid/rest/v1/rpc/finalize_verified_file_v2")).rejects.toThrow();
  await expect(transport(`${target}/rest/v1/rpc/process_due_messages`)).rejects.toThrow();
  await expect(smoke.main({ ...config, target: "https://production.invalid" })).rejects.toThrow();
});
it("persists database-generated event IDs and location bid IDs for crash recovery before later mutations", async () => {
  const value = { ...privateReceipt(), locationBidIds: [] as string[], eventIds: [] as string[] }, saves: object[] = [];
  const contextId = "70000000-0000-4000-8000-000000000040", eventId = "70000000-0000-4000-8000-000000000041";
  const service = { from: (table: string) => { const query = { select: () => query, eq: (_column: string, id: string) => { expect(id).toBe(value.bidIds[0]); return query; }, then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: [table === "bid_events" ? {id:eventId} : {bid_id:contextId}], error: null }).then(resolve) }; return query; } };
  const record = "recordUploadIds" in smoke ? smoke.recordUploadIds : async () => {};
  await record(service, value, async () => { saves.push(structuredClone(value)); });
  expect(saves).toEqual([expect.objectContaining({ locationBidIds: [contextId], eventIds: [eventId] })]);
});
