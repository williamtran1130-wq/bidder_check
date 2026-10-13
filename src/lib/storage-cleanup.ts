import "server-only";
import { adminClient } from "./admin";
import { withinDeadline } from "./work-deadline";

const BATCH = 50;
export type CleanupResult = {
  attempted: number;
  succeeded: number;
  failed: number;
};
type Options = {
  maxBatches?: number;
  deadlineMs?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
};

/**
 * Bounded passes (default one). Failed calls leave durable tasks available after their
 * lease. Logs carry counts only, never file paths or Storage error text.
 */
export async function runStorageCleanup(
  operation?: string,
  { maxBatches = 1, deadlineMs, deadlineAt, signal }: Options = {},
): Promise<CleanupResult> {
  const enteredAt = Date.now();
  const stopAt = Math.min(
    enteredAt + 50000,
    deadlineAt ?? Infinity,
    deadlineMs === undefined ? Infinity : enteredAt + deadlineMs,
  );
  const admin = adminClient({ deadlineAt: stopAt, signal });
  const run = <T>(send: () => PromiseLike<T>) =>
    withinDeadline(send, stopAt, signal);
  // Temporary narrow adapter until the new migration's generated types land.
  const finishBatch = admin.rpc.bind(admin) as unknown as (
    name: "finish_storage_cleanup_batch",
    args: { p_tasks: string[]; p_leases: string[]; p_success: boolean },
  ) => PromiseLike<{ error: unknown }>;
  const total: CleanupResult = { attempted: 0, succeeded: 0, failed: 0 };
  for (
    let batch = 0;
    batch < maxBatches && Date.now() < stopAt - 5000;
    batch++
  ) {
    const { data: tasks, error } = await run(() =>
      admin.rpc("claim_storage_cleanup", {
        p_operation: operation ?? null,
        p_limit: BATCH,
      }),
    );
    if (error) {
      console.error("[storage-cleanup] claim failed", { ...total });
      throw new Error("Screenshot cleanup is pending. Please retry.");
    }
    if (!tasks?.length) break;
    let success = false;
    try {
      const result = await run(() =>
        admin.storage
          .from("private-files")
          .remove(tasks.map((t) => t.storage_path!)),
      );
      success = !result.error;
    } catch {
      /* Persist failure; never report physical removal as successful. */
    }
    // Storage returns one batch-level error; never infer per-object outcomes.
    // Unknown removals stay retryable. Successful removals enter the original
    // delayed second pass, which is acknowledged only under each matching lease.
    const { error: finishError } = await run(() =>
      finishBatch("finish_storage_cleanup_batch", {
        p_tasks: tasks.map((task) => task.id),
        p_leases: tasks.map((task) => task.lease_id!),
        p_success: success,
      }),
    );
    total.attempted += tasks.length;
    total[success ? "succeeded" : "failed"] += tasks.length;
    if (finishError) {
      console.error("[storage-cleanup] finish failed", { ...total });
      throw new Error("Screenshot cleanup is pending. Please retry.");
    }
    if (!success)
      console.error("[storage-cleanup] removal failed", { ...total });
    if (tasks.length < BATCH) break;
  }
  if (total.attempted)
    console.info("[storage-cleanup] pass complete", { ...total });
  return total;
}
