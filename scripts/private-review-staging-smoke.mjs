// Dedicated staging only. This helper never uploads storage data.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { Agent, request } from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

export const STAGING = "https://kdmvludtvhuuewmhurpw.supabase.co";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LABELS = ["owner", "admin", "bidder1", "bidder2", "outsider"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (response) => { if (response.error) throw new Error("Hosted operation failed; details withheld"); return response.data; };

export function guardedPath(value) {
  assert.equal(typeof value, "string", "Explicit private JSON path required");
  const root = path.resolve(".superpowers"), resolved = path.resolve(value), relative = path.relative(root, resolved);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Private receipt must be beneath .superpowers");
  assert.equal(path.extname(resolved), ".json", "Private receipt must be JSON");
  return resolved;
}
function option(args, flag) { const index = args.indexOf(flag); if (index < 0) return null; assert.ok(args[index + 1] && !args[index + 1].startsWith("--"), "Flag value required"); return args[index + 1]; }
export function validateConfiguration({ target, publishableKey, secretKey, args }) {
  assert.equal(target, STAGING, "Dedicated staging only");
  assert.ok(publishableKey && secretKey, "Staging keys required");
  const valued = ["--receipt", "--output", "--concurrency-gate"];
  const flags = ["--staging-ready", "--keep-fixture", "--cleanup-only", ...valued];
  const seen = new Set();
  for (let index = 0; index < args.length; index++) { const flag = args[index]; assert.ok(flags.includes(flag) && !seen.has(flag), "Unsupported or repeated flag"); seen.add(flag); if (valued.includes(flag)) { assert.ok(args[++index] && !args[index].startsWith("--"), "Flag value required"); } }
  assert.ok(seen.has("--staging-ready"), "Explicit staging-ready authorization required");
  const keep = seen.has("--keep-fixture"), recovery = seen.has("--cleanup-only");
  assert.ok(!(keep && recovery), "Keep and recovery are mutually exclusive");
  const benchmarkPath = guardedPath(option(args, "--receipt")), outputPath = guardedPath(option(args, "--output"));
  assert.notEqual(benchmarkPath.toLowerCase(), outputPath.toLowerCase(), "Do not overwrite the benchmark receipt");
  const gateValue = option(args, "--concurrency-gate"), gatePath = gateValue ? guardedPath(gateValue) : null;
  if (gatePath) { assert.ok(!recovery, "Recovery does not use a gate"); assert.ok(![benchmarkPath, outputPath].map((value) => value.toLowerCase()).includes(gatePath.toLowerCase()), "Gate must have its own path"); }
  return { target, publishableKey, secretKey, benchmarkPath, outputPath, gatePath, keep, recovery };
}
function matrixKey(row) { return JSON.stringify([row.role, row.range, row.scope, row.sort, row.descending, row.screenshotFilter, row.status, row.arrangement]); }
function fullMatrix() {
  const rows = [];
  const add = (role, range, sort, descending, repeated = false, scope = "main", status = "all", arrangement = null) => rows.push({ role, range, scope, sort, descending, screenshotFilter: repeated ? "Repeated sizes only" : "", status, arrangement });
  const sorts = [["found_at", true], ["screenshot_size_bytes", false], ["screenshot_size_bytes", true]];
  for (const role of ["client", "admin", "bidder"]) for (const range of ["all", "recent"]) for (const [sort, descending] of sorts) { add(role, range, sort, descending); add(role, range, sort, descending, true); }
  add("admin", "all", "screenshot_size_bytes", false, false, "authorized-cross-workspace");
  add("client", "all", "screenshot_size_bytes", false, false, "filtered-bidder");
  add("client", "all", "screenshot", true, false, "presence-sort");
  for (const role of ["client", "admin"]) for (const status of ["applied", "unapplied", "pending_review"]) for (const descending of [false, true]) add(role, "all", "screenshot_size_bytes", descending, true, "main", status);
  for (const descending of [false, true]) { add("admin", "all", "screenshot_size_bytes", descending, true, "authorized-cross-workspace"); add("client", "all", "screenshot_size_bytes", descending, true, "filtered-bidder"); add("client", "recent", "screenshot_size_bytes", descending, true, "filtered-arrangement", "all", "remote"); }
  return new Set(rows.map(matrixKey));
}
export function validateBenchmarkReceipt(value) {
  assert.equal(value.version, 1); assert.equal(value.target, STAGING); assert.equal(value.mode, "after");
  assert.match(value.marker, /^screenshot-size-bench-[0-9a-f-]{36}$/); assert.match(value.marker.slice("screenshot-size-bench-".length), UUID);
  assert.equal(value.passed, true); assert.equal(value.fixtureRetained, true); assert.equal(value.cleanupComplete, false); assert.equal(value.matrixKind, "full");
  assert.equal(value.fixtureBids, 25000); assert.ok(Number.isSafeInteger(value.representativeBids) && value.representativeBids > 0 && value.representativeBids <= 12500);
  assert.equal(value.fixtureVolumeMultiple, value.fixtureBids / value.representativeBids); assert.ok(value.fixtureVolumeMultiple >= 2); assert.equal(value.p95LimitMs, 10000);
  assert.equal(value.accounts.length, 5); assert.equal(new Set(value.accounts.map((actor) => actor.id)).size, 5);
  value.accounts.forEach((actor, index) => { assert.equal(actor.label, LABELS[index]); assert.match(actor.id, UUID); assert.equal(actor.email, `${value.marker}-${actor.label}@example.com`); });
  assert.equal(value.workspaceIds.length, 5); assert.equal(new Set(value.workspaceIds).size, 5); value.workspaceIds.forEach((id) => assert.match(id, UUID));
  assert.equal(value.results.length, 57); const expected = fullMatrix();
  for (const row of value.results) {
    assert.ok(expected.delete(matrixKey(row)), "Missing, duplicated or unexpected benchmark dimension");
    assert.equal(row.matrixKind, "full"); assert.equal(row.passed, true); assert.equal(row.concurrency, 5); assert.equal(row.p95LimitMs, 10000);
    assert.ok(Number.isFinite(row.p95Ms) && row.p95Ms >= 0 && row.p95Ms < 10000); assert.ok(Number.isSafeInteger(row.samples) && row.samples >= 5);
  }
  assert.equal(expected.size, 0);
}
export async function verifyFixtureOwnership(service, benchmark) {
  validateBenchmarkReceipt(benchmark);
  for (const actor of benchmark.accounts) { const user = ok(await service.auth.admin.getUserById(actor.id)).user; assert.equal(user.id, actor.id); assert.equal(user.email, actor.email); assert.ok(!user.banned_until || Date.parse(user.banned_until) < Date.now()); }
  const profiles = ok(await service.from("profiles").select("id,email,role,archived,approval_status").in("id", benchmark.accounts.map((actor) => actor.id)));
  assert.equal(profiles.length, 5);
  benchmark.accounts.forEach((actor, index) => { const profile = profiles.find((row) => row.id === actor.id); assert.ok(profile); assert.equal(profile.email, actor.email); assert.equal(profile.role, index < 2 ? ["client", "admin"][index] : "bidder"); assert.equal(profile.archived, false); assert.equal(profile.approval_status, "approved"); });
  const workspaces = ok(await service.from("workspaces").select("id,owner_id").in("id", benchmark.workspaceIds));
  assert.equal(workspaces.length, 5); assert.equal(new Set(workspaces.map((row) => row.owner_id)).size, 5);
  workspaces.forEach((row) => assert.ok(benchmark.accounts.some((actor) => actor.id === row.owner_id)));
  const owner = benchmark.accounts[0], bidder = benchmark.accounts[2], workspaceId = workspaces.find((row) => row.owner_id === owner.id)?.id; assert.ok(workspaceId);
  const membership = ok(await service.from("bidders").select("user_id,workspace_id,archived").eq("user_id", bidder.id).eq("workspace_id", workspaceId));
  assert.equal(membership.length, 1); assert.equal(membership[0].user_id, bidder.id); assert.equal(membership[0].workspace_id, workspaceId); assert.equal(membership[0].archived, false);
  const assignments = ok(await service.from("resumes").select("id,workspace_id,bidder_id,identifier,profile_id,archived").eq("workspace_id", workspaceId).eq("bidder_id", bidder.id).eq("identifier", `${benchmark.marker}-0`).limit(2));
  assert.equal(assignments.length, 1); const assignment = assignments[0]; assert.match(assignment.id, UUID); assert.equal(assignment.identifier, `${benchmark.marker}-0`); assert.equal(assignment.workspace_id, workspaceId); assert.equal(assignment.bidder_id, bidder.id); assert.equal(assignment.archived, false);
  const candidates = ok(await service.from("candidate_profiles").select("id,workspace_id,identifier").eq("id", assignment.profile_id));
  assert.equal(candidates.length, 1); assert.equal(candidates[0].id, assignment.profile_id); assert.equal(candidates[0].workspace_id, workspaceId); assert.equal(candidates[0].identifier, `${benchmark.marker}-0`);
  return { owner, bidder, workspaceId, assignmentId: assignment.id };
}

// One agent per service transport ensures distinct TCP connections even if the
// default global fetch implementation pools requests to the same origin.
export function isolatedServiceFetch(agent) {
  return async (input, init) => {
    const message = new Request(input, init), url = new URL(message.url); assert.equal(url.origin, STAGING);
    assert.equal(url.pathname, "/rest/v1/rpc/finalize_verified_file_v2", "Isolated transport is finalizer-only");
    const bytes = Buffer.from(await message.arrayBuffer());
    return new Promise((resolve, reject) => {
      const outgoing = request(url, { method: message.method, headers: Object.fromEntries(message.headers), agent, timeout: 20000 }, (incoming) => {
        const chunks = []; let size = 0;
        incoming.on("data", (chunk) => { size += chunk.length; if (size > 1024 * 1024) incoming.destroy(new Error("Bounded response exceeded")); else chunks.push(chunk); });
        incoming.on("error", reject); incoming.on("end", () => { const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(",") : value); resolve(new Response(incoming.statusCode === 204 ? null : Buffer.concat(chunks), { status: incoming.statusCode, headers })); });
      });
      outgoing.on("timeout", () => outgoing.destroy(new Error("Bounded hosted request timed out"))); outgoing.on("error", reject); outgoing.end(bytes);
    });
  };
}
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(15000) }) } };
async function authenticate(service, actor, publishableKey, sessions) {
  const generated = ok(await service.auth.admin.generateLink({ type: "magiclink", email: actor.email }));
  assert.equal(generated.user.id, actor.id); assert.equal(generated.user.email, actor.email); assert.ok(generated.properties.hashed_token);
  const client = createClient(STAGING, publishableKey, clientOptions); sessions.push(client);
  const verified = ok(await client.auth.verifyOtp({ token_hash: generated.properties.hashed_token, type: "email" }));
  assert.equal(verified.user.id, actor.id); assert.ok(verified.session); return client;
}
async function existingPrivatePath(value) { const resolved = await realpath(guardedPath(value)); guardedPath(resolved); return resolved; }
async function privateParent(value) { await mkdir(path.dirname(value), { recursive: true }); guardedPath(path.join(await realpath(path.dirname(value)), path.basename(value))); }
export async function savePrivateReceipt(receiptPath, receipt, initial = false) {
  await privateParent(receiptPath); receipt.updatedAt = new Date().toISOString();
  const temporary = initial ? receiptPath : `${receiptPath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600); try { await handle.writeFile(JSON.stringify(receipt, null, 2)); await handle.sync(); } finally { await handle.close(); }
  if (!initial) await rename(temporary, receiptPath);
}
export function validatePrivateReceipt(value, benchmark, benchmarkPath) {
  assert.equal(value.version, 1); assert.equal(value.target, STAGING); assert.equal(value.benchmarkPath, benchmarkPath);
  assert.equal(value.benchmarkMarker, benchmark.marker); assert.ok(value.marker.startsWith(`${benchmark.marker}-private-`)); assert.match(value.marker.slice(`${benchmark.marker}-private-`.length), UUID);
  assert.match(value.workspaceId, UUID); assert.equal(value.ownerId, benchmark.accounts[0].id); assert.equal(value.bidderId, benchmark.accounts[2].id); assert.match(value.assignmentId, UUID);
  assert.equal(value.bidIds.length, 2); assert.equal(value.fileIds.length, 2);
  const ids = [...value.bidIds, ...value.fileIds]; ids.forEach((id) => assert.match(id, UUID)); assert.equal(new Set(ids).size, 4);
}
async function verifyOwnResources(service, receipt) {
  const bids = ok(await service.from("bids").select("id,workspace_id,bidder_id,resume_id,company").in("id", receipt.bidIds));
  for (const row of bids) { assert.equal(row.workspace_id, receipt.workspaceId); assert.equal(row.bidder_id, receipt.bidderId); assert.equal(row.resume_id, receipt.assignmentId); assert.ok([`${receipt.marker}-atomic`, `${receipt.marker}-ui`].includes(row.company)); }
  const files = ok(await service.from("files").select("id,workspace_id,bidder_id,bid_id,created_by,storage_path").in("id", receipt.fileIds));
  for (const row of files) { assert.equal(row.workspace_id, receipt.workspaceId); assert.equal(row.bidder_id, receipt.bidderId); assert.equal(row.bid_id, receipt.bidIds[0]); assert.equal(row.created_by, receipt.ownerId); assert.equal(row.storage_path, `${receipt.marker}/${row.id}`); }
  return { bids, files };
}
export async function cleanupOwnedResources(service, receipt, save) {
  await verifyOwnResources(service, receipt); receipt.phase = "cleanup"; await save();
  ok(await service.from("bid_events").delete().in("bid_id", receipt.bidIds));
  ok(await service.from("bids").update({ applied: false, evidence_file_id: null }).in("id", receipt.bidIds).eq("workspace_id", receipt.workspaceId));
  ok(await service.from("files").delete().in("id", receipt.fileIds).eq("workspace_id", receipt.workspaceId));
  ok(await service.from("bids").delete().in("id", receipt.bidIds).eq("workspace_id", receipt.workspaceId));
  for (const [table, column, ids] of [["bids", "id", receipt.bidIds], ["files", "id", receipt.fileIds], ["bid_events", "bid_id", receipt.bidIds], ["bid_application_locations", "bid_id", receipt.bidIds]]) {
    const result = await service.from(table).select(column, { count: "exact", head: true }).in(column, ids); ok(result); assert.equal(result.count, 0);
  }
  receipt.cleanupComplete = true; receipt.fixtureRetained = false; receipt.phase = "cleaned"; await save();
}
// The RPC creates these child IDs itself. Discover and persist them immediately
// after each successful transaction, before issuing subsequent writes.
export async function recordUploadIds(service, receipt, save) {
  const locations = ok(await service.from("bid_application_locations").select("bid_id").eq("bid_id", receipt.bidIds[0]));
  const events = ok(await service.from("bid_events").select("id").eq("bid_id", receipt.bidIds[0]));
  for (const row of events) assert.match(row.id, UUID);
  for (const row of locations) assert.match(row.bid_id, UUID);
  receipt.locationBidIds = locations.map((row) => row.bid_id); receipt.eventIds = events.map((row) => row.id); await save();
}
async function gate(config, receipt, save) {
  if (!config.gatePath) return;
  receipt.phase = "awaiting-concurrency-gate"; await save(); const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(await existingPrivatePath(config.gatePath), "utf8"));
      assert.equal(value.version, 1); assert.equal(value.target, STAGING); assert.equal(value.marker, receipt.marker); assert.equal(value.bidId, receipt.bidIds[0]); assert.equal(value.release, true); return;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await sleep(1000);
  }
  throw new Error("Concurrency gate deadline exceeded");
}
async function checkUploads(config, service, owner, bidder, receipt, save, transports) {
  const bidId = receipt.bidIds[0], firstId = receipt.fileIds[0], nextId = receipt.fileIds[1];
  receipt.phase = "create-upload-fixture"; await save();
  ok(await service.from("bids").insert({ id: bidId, workspace_id: receipt.workspaceId, bidder_id: receipt.bidderId, resume_id: receipt.assignmentId, company: `${receipt.marker}-atomic`, role_name: "Synthetic engineer", url: `https://private-review.invalid/${receipt.marker}/atomic`, normalized_url: `https://private-review.invalid/${receipt.marker}/atomic`, source: "synthetic", arrangement: "remote", review_status: "approved", review_revision: 1, rate_cents: 100 }));
  for (const id of receipt.fileIds) {
    await save(); ok(await service.from("files").insert({ id, workspace_id: receipt.workspaceId, bidder_id: receipt.bidderId, bid_id: bidId, kind: "screenshot", filename: `${receipt.marker}.png`, mime: "image/png", size_bytes: 100, storage_path: `${receipt.marker}/${id}`, created_by: receipt.ownerId, review_revision: 1 }));
  }
  const firstContext = { ip: "203.0.113.10", city: "Synthetic City", region: "IL", country: "US", source: "vercel", status: "available" };
  const secondContext = { ...firstContext, ip: "198.51.100.2" };
  const finalArgs = { p_id: firstId, p_sha: "a".repeat(64), p_actor: receipt.ownerId };
  await gate(config, receipt, save); receipt.phase = "concurrent-finalization"; await save();
  const settled = await Promise.allSettled(transports.map((client, index) => client.rpc("finalize_verified_file_v2", { ...finalArgs, p_context: index ? secondContext : firstContext })));
  for (const result of settled) { if (result.status === "rejected") throw result.reason; ok(result.value); }
  const location = async (client,trash=false) => {
    const page=ok(await client.rpc("list_bids_v2",{p_query:{scopeBidderId:receipt.bidderId,search:receipt.marker,trash,pageSize:100}}));
    return page.rows.find(row=>row.id===bidId)?.applicationLocation ?? null;
  };
  const current = await location(owner);
  const stored = ok(await service.from("bid_application_locations").select("uploader_id,uploader_role,bidder_id").eq("bid_id",bidId).single());
  assert.equal(stored.uploader_id,receipt.ownerId); assert.equal(stored.uploader_role,"client"); assert.equal(stored.bidder_id,receipt.bidderId);
  assert.ok([firstContext.ip,secondContext.ip].includes(current.ip));
  let locations = await service.from("bid_application_locations").select("bid_id",{count:"exact",head:true}).eq("bid_id",bidId); ok(locations); assert.equal(locations.count,1);
  const events = await service.from("bid_events").select("id",{count:"exact",head:true}).eq("bid_id",bidId).eq("file_id",firstId); ok(events); assert.equal(events.count,1);
  await recordUploadIds(service,receipt,save);
  assert.deepEqual(await location(bidder),current);
  assert.equal((await bidder.from("bid_application_locations").select("bid_id")).error?.code,"42501");
  assert.equal((await owner.rpc("finalize_verified_file_v2",{...finalArgs,p_context:firstContext})).error?.code,"42501");
  receipt.phase="retry-replacement"; await save();
  ok(await service.rpc("finalize_verified_file_v2",{...finalArgs,p_context:current.ip===firstContext.ip ? secondContext:firstContext}));
  assert.deepEqual(await location(owner),current);
  ok(await service.rpc("finalize_verified_file_v2",{p_id:nextId,p_sha:"b".repeat(64),p_actor:receipt.ownerId,p_context:{...firstContext,ip:"2001:db8::1",country:"CA"}}));
  const latest=await location(owner); assert.equal(latest.ip,"2001:db8::1"); assert.equal(latest.country,"CA");
  locations=await service.from("bid_application_locations").select("bid_id",{count:"exact",head:true}).eq("bid_id",bidId); ok(locations); assert.equal(locations.count,1);
  await recordUploadIds(service,receipt,save);
  ok(await owner.rpc("trash_bid",{p_bid:bidId,p_deleted:true})); assert.deepEqual(await location(owner,true),latest);
  receipt.phase="metadata-deletion"; await save();
  ok(await service.from("bids").update({applied:false,evidence_file_id:null}).eq("id",bidId).eq("workspace_id",receipt.workspaceId));
  assert.deepEqual(await location(owner,true),latest);
  receipt.phase="bid-cascade"; await save();
  ok(await service.from("bid_events").delete().eq("bid_id",bidId));
  ok(await service.from("files").delete().eq("id",nextId).eq("bid_id",bidId));
  ok(await service.from("bids").delete().eq("id",bidId).eq("workspace_id",receipt.workspaceId));
  locations=await service.from("bid_application_locations").select("bid_id",{count:"exact",head:true}).eq("bid_id",bidId); ok(locations); assert.equal(locations.count,0);
  receipt.counts={concurrentRequests:2,firstSuccessLocations:1,firstSuccessEvents:1,retainedReplacementLocations:1,locationsAfterBidDeletion:0,bidderOwnLocationReads:1};
  await save();
}
export async function main(input) {
  const config = validateConfiguration(input), benchmarkPath = await existingPrivatePath(config.benchmarkPath);
  const benchmarkBytes = await readFile(benchmarkPath, "utf8"), benchmark = JSON.parse(benchmarkBytes); validateBenchmarkReceipt(benchmark);
  const service = createClient(STAGING, config.secretKey, clientOptions), scope = await verifyFixtureOwnership(service, benchmark), sessions = [], agents = [];
  let receipt, started = false, failure = false;
  const save = () => savePrivateReceipt(config.outputPath, receipt);
  try {
    if (config.recovery) {
      receipt = JSON.parse(await readFile(await existingPrivatePath(config.outputPath), "utf8")); validatePrivateReceipt(receipt, benchmark, benchmarkPath);
      assert.equal(receipt.workspaceId, scope.workspaceId); assert.equal(receipt.assignmentId, scope.assignmentId); await cleanupOwnedResources(service, receipt, save); return;
    }
    const marker = `${benchmark.marker}-private-${randomUUID()}`;
    receipt = { version: 1, target: STAGING, benchmarkPath, benchmarkMarker: benchmark.marker, benchmarkSha256: createHash("sha256").update(benchmarkBytes).digest("hex"), marker, workspaceId: scope.workspaceId, ownerId: scope.owner.id, bidderId: scope.bidder.id, assignmentId: scope.assignmentId, bidIds: [randomUUID(), randomUUID()], fileIds: [randomUUID(), randomUUID()], locationBidIds: [], eventIds: [], counts: {}, phase: "planned", passed: false, cleanupComplete: false, fixtureRetained: false, createdAt: new Date().toISOString() };
    validatePrivateReceipt(receipt, benchmark, benchmarkPath); await savePrivateReceipt(config.outputPath, receipt, true); started = true;
    const owner = await authenticate(service, scope.owner, config.publishableKey, sessions), bidder = await authenticate(service, scope.bidder, config.publishableKey, sessions);
    const transports = [0, 1].map(() => { const agent = new Agent({ keepAlive: true, maxSockets: 1 }); agents.push(agent); return createClient(STAGING, config.secretKey, { ...clientOptions, global: { fetch: isolatedServiceFetch(agent) } }); });
    await checkUploads(config, service, owner, bidder, receipt, save, transports);
    if (config.keep) {
      receipt.phase = "create-ui-target"; await save();
      ok(await service.from("bids").insert({ id: receipt.bidIds[1], workspace_id: receipt.workspaceId, bidder_id: receipt.bidderId, resume_id: receipt.assignmentId, company: `${receipt.marker}-ui`, role_name: "Synthetic UI upload target", url: `https://private-review.invalid/${receipt.marker}/ui`, normalized_url: `https://private-review.invalid/${receipt.marker}/ui`, source: "synthetic", arrangement: "remote", review_status: "approved", review_revision: 1, rate_cents: 100 }));
    }
    receipt.passed = true; receipt.fixtureRetained = config.keep; receipt.phase = "passed"; await save();
  } catch { failure = true; if (receipt) { receipt.passed = false; receipt.failureCount = 1; await save().catch(() => {}); } throw new Error("Staging acceptance failed; private details withheld"); }
  finally {
    if (started && !(config.keep && receipt.passed && !failure)) await cleanupOwnedResources(service, receipt, save).catch(() => { receipt.cleanupComplete = false; receipt.cleanupFailureCount = 1; failure = true; });
    for (const client of sessions) { const result = await client.auth.signOut({ scope: "local" }).catch(() => ({ error: true })); if (result.error) { failure = true; if (receipt) receipt.sessionCleanupFailureCount = (receipt.sessionCleanupFailureCount ?? 0) + 1; } }
    for (const agent of agents) agent.destroy();
    if (receipt) { if (failure) receipt.passed = false; await save().catch(() => { failure = true; }); console.log(JSON.stringify({ passed: receipt.passed && !failure, cleanupComplete: receipt.cleanupComplete, fixtureRetained: receipt.fixtureRetained, ...receipt.counts, failures: failure ? 1 : 0 })); }
    if (failure) process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main({ target: process.env.NEXT_PUBLIC_SUPABASE_URL, publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, secretKey: process.env.SUPABASE_SECRET_KEY, args: process.argv.slice(2) }); }
  catch { console.error(JSON.stringify({ passed: false, failures: 1 })); process.exitCode = 1; }
}
