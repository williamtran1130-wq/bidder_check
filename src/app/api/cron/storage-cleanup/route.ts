import { timingSafeEqual } from "node:crypto";
import { runStorageCleanup } from "@/lib/storage-cleanup";
import { adminClient } from "@/lib/admin";
import { withinDeadline } from "@/lib/work-deadline";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  const deadlineAt = Date.now() + 50000;
  const run = <T>(send: () => PromiseLike<T>) =>
    withinDeadline(send, deadlineAt, request.signal);
  const secret = process.env.CRON_SECRET;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (
    !secret ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  let phase = "admin-client";
  try {
    const admin = adminClient({ deadlineAt, signal: request.signal });
    phase = "retention";
    const { data: retention, error: retentionError } = await run(() =>
      admin.rpc("process_candidate_retention", { p_limit: 1000 }),
    );
    if (retentionError)
      throw new Error(`Retention pass failed: ${retentionError.message}`);
    phase = "screenshot-retention";
    const { data: screenshots, error: screenshotError } = await run(() =>
      admin.rpc("process_screenshot_retention", { p_limit: 500 }),
    );
    if (screenshotError) throw new Error("Screenshot expiry pending");
    phase = "legacy-cleanup";
    const { data: legacy, error: legacyError } = await run(() =>
      admin.rpc("process_legacy_file_cleanup", { p_limit: 200 }),
    );
    if (legacyError) throw new Error("Legacy cleanup pending");
    // Drain backlogs inside the function limit; leases make overlapping calls safe.
    phase = "storage-cleanup";
    const storageCleanup = await runStorageCleanup(undefined, {
      maxBatches: 20,
      deadlineAt,
      signal: request.signal,
    });
    phase = "cleanup-status";
    const { data: cleanupStatus, error: statusError } = await run(() =>
      admin.rpc("retention_cleanup_status"),
    );
    if (statusError)
      throw new Error(`Cleanup status unavailable: ${statusError.message}`);
    return Response.json(
      { retention, screenshots, legacy, storageCleanup, cleanupStatus },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    console.error("[storage-cleanup] request failed", {
      phase,
    });
    return Response.json(
      { error: "Cleanup pending; retry scheduled" },
      { status: 503 },
    );
  }
}
