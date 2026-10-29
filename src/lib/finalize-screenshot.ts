import "server-only";
import { adminClient } from "./admin";
import { compressScreenshot } from "./screenshot-compression";
import { ActionValidationError } from "./action-errors";
import type { CapturedUploadContext } from "./upload-context-types";

type Input = {
  fileId: string;
  actorId: string;
  sourceSha256: string;
  bytes: Uint8Array;
  context: CapturedUploadContext;
};

/** Original bytes have already passed caller-scoped validation and hashing. */
export async function finalizeScreenshotUpload(input: Input): Promise<void> {
  const started = Date.now();
  const enabled = process.env.SCREENSHOT_COMPRESSION_ENABLED === "true";
  const compressed = enabled ? await compressScreenshot(input.bytes) : null;
  let retainedBytes = input.bytes.length;
  let successes = 0;
  // Bound candidate requests well inside its ten-minute abandoned cleanup window.
  const admin = adminClient(true);
  const original = {
    p_id: input.fileId,
    p_actor: input.actorId,
    p_sha: input.sourceSha256,
    p_context: input.context,
  };
  if (compressed) {
    const reserved = await admin.rpc("reserve_screenshot_optimization", {
      p_id: input.fileId, p_actor: input.actorId,
    });
    if (reserved.error) throw reserved.error;
    // Reservation is a service-only API; never derive a candidate path in the browser.
    const candidate = reserved.data as
      | { finalized: true; sha256: string; stored_size_bytes: number }
      | { finalized?: false; attempt_id: string; storage_path: string }
      | null;
    if (candidate?.finalized) {
      if (candidate.sha256 !== input.sourceSha256) throw new Error("Immutable file");
      retainedBytes = candidate.stored_size_bytes;
      successes = retainedBytes < input.bytes.length ? 1 : 0;
    } else {
      if (!candidate?.attempt_id || !candidate.storage_path)
        throw new ActionValidationError("Screenshot verification changed. Please retry.");
      const uploaded = await admin.storage.from("private-files").upload(
        candidate.storage_path, compressed.bytes, { contentType: compressed.mime, upsert: false },
      );
      if (uploaded.error)
        throw new ActionValidationError("Screenshot optimization could not finish. Please retry.");
      const finalized = await admin.rpc("finalize_optimized_screenshot", {
        ...original, p_attempt: candidate.attempt_id,
        p_stored_size: compressed.bytes.length, p_stored_sha: compressed.sha256,
      });
      // A failed/uncertain response must not remove a candidate that may have committed.
      // The database cancels its abandoned cleanup only when activation commits.
      if (finalized.error) throw finalized.error;
      retainedBytes = compressed.bytes.length;
      successes = 1;
    }
  } else {
    const finalized = await admin.rpc("finalize_verified_file_v2", original);
    if (finalized.error) throw finalized.error;
  }
  if (enabled) console.info("[screenshot-compression] finalized", {
    inputBytes: input.bytes.length,
    retainedBytes,
    successes,
    fallbacks: 1 - successes,
    durationMs: Date.now() - started,
  });
}
