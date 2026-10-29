import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rpc: vi.fn(), upload: vi.fn(), compress: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin", () => ({ adminClient: () => ({
  rpc: h.rpc, storage: { from: () => ({ upload: h.upload }) },
}) }));
vi.mock("@/lib/screenshot-compression", () => ({ compressScreenshot: h.compress }));
import { finalizeScreenshotUpload } from "@/lib/finalize-screenshot";

const input = {
  fileId: "40000000-0000-4000-8000-000000000001",
  actorId: "40000000-0000-4000-8000-000000000002",
  sourceSha256: "a".repeat(64), bytes: new Uint8Array(1000),
  context: { ip: null, city: null, region: null, country: null, source: "unavailable", status: "unavailable" } as const,
};
beforeEach(() => {
  vi.stubEnv("SCREENSHOT_COMPRESSION_ENABLED", "true");
  h.rpc.mockReset().mockImplementation(async (name) => name === "reserve_screenshot_optimization"
    ? { data: { attempt_id: "attempt", storage_path: "private/candidate.webp" }, error: null }
    : { error: null });
  h.upload.mockReset().mockResolvedValue({ error: null });
  h.compress.mockReset().mockResolvedValue({ bytes: Buffer.alloc(200), mime: "image/webp", sha256: "b".repeat(64) });
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each([undefined, "false", "1"])("keeps original finalization when flag is %s", async (flag) => {
  vi.stubEnv("SCREENSHOT_COMPRESSION_ENABLED", flag);
  await finalizeScreenshotUpload(input);
  expect(h.compress).not.toHaveBeenCalled();
  expect(h.rpc).toHaveBeenCalledExactlyOnceWith("finalize_verified_file_v2", {
    p_id: input.fileId, p_actor: input.actorId, p_sha: input.sourceSha256, p_context: input.context,
  });
  expect(h.upload).not.toHaveBeenCalled();
});

it("reserves before uploading without overwrite and atomically activates using original proof hash", async () => {
  await finalizeScreenshotUpload(input);
  expect(h.rpc).toHaveBeenNthCalledWith(1, "reserve_screenshot_optimization", { p_id: input.fileId, p_actor: input.actorId });
  expect(h.upload).toHaveBeenCalledExactlyOnceWith("private/candidate.webp", Buffer.alloc(200), { contentType: "image/webp", upsert: false });
  expect(h.rpc).toHaveBeenNthCalledWith(2, "finalize_optimized_screenshot", {
    p_id: input.fileId, p_actor: input.actorId, p_sha: input.sourceSha256, p_context: input.context,
    p_attempt: "attempt", p_stored_size: 200, p_stored_sha: "b".repeat(64),
  });
  expect(h.rpc.mock.invocationCallOrder[0]).toBeLessThan(h.upload.mock.invocationCallOrder[0]);
  expect(h.upload.mock.invocationCallOrder[0]).toBeLessThan(h.rpc.mock.invocationCallOrder[1]);
  expect(console.info).toHaveBeenCalledWith("[screenshot-compression] finalized", {
    inputBytes: 1000, retainedBytes: 200, successes: 1, fallbacks: 0, durationMs: expect.any(Number),
  });
});

it("falls back to original when encoding offers no savings", async () => {
  h.compress.mockResolvedValue(null);
  await finalizeScreenshotUpload(input);
  expect(h.rpc).toHaveBeenCalledExactlyOnceWith("finalize_verified_file_v2", expect.objectContaining({ p_sha: input.sourceSha256 }));
  expect(h.upload).not.toHaveBeenCalled();
  expect(console.info).toHaveBeenCalledWith("[screenshot-compression] finalized", expect.objectContaining({ retainedBytes: 1000, successes: 0, fallbacks: 1 }));
});

it("does not upload without a durable reservation", async () => {
  h.rpc.mockResolvedValue({ error: { message: "Access denied" } });
  await expect(finalizeScreenshotUpload(input)).rejects.toMatchObject({ message: "Access denied" });
  expect(h.upload).not.toHaveBeenCalled();
});

it("accepts a concurrent finalization that committed while this request was encoding", async () => {
  h.rpc.mockResolvedValue({ data: { finalized: true, sha256: input.sourceSha256, stored_size_bytes: 180 }, error: null });
  await expect(finalizeScreenshotUpload(input)).resolves.toBeUndefined();
  expect(h.upload).not.toHaveBeenCalled();
  expect(h.rpc).toHaveBeenCalledTimes(1);
  expect(console.info).toHaveBeenCalledWith("[screenshot-compression] finalized", expect.objectContaining({ retainedBytes: 180 }));
});

it("rejects a concurrent winner with different original bytes", async () => {
  h.rpc.mockResolvedValue({ data: { finalized: true, sha256: "c".repeat(64), stored_size_bytes: 180 }, error: null });
  await expect(finalizeScreenshotUpload(input)).rejects.toThrow("Immutable file");
  expect(h.upload).not.toHaveBeenCalled();
});

it("interleaves two finalizations and uploads only the winning candidate", async () => {
  let releaseEncoding!: () => void;
  const encoded = new Promise<void>((resolve) => { releaseEncoding = resolve; });
  const output = { bytes: Buffer.alloc(200), mime: "image/webp", sha256: "b".repeat(64) };
  h.compress.mockResolvedValueOnce(output).mockImplementationOnce(async () => { await encoded; return output; });
  let committed = false;
  h.rpc.mockImplementation(async (name) => {
    if (name === "reserve_screenshot_optimization") return { data: committed
      ? { finalized: true, sha256: input.sourceSha256, stored_size_bytes: 200 }
      : { attempt_id: "winner", storage_path: "private/winner.webp" }, error: null };
    committed = true;
    releaseEncoding();
    return { error: null };
  });
  await expect(Promise.all([finalizeScreenshotUpload(input), finalizeScreenshotUpload(input)])).resolves.toEqual([undefined, undefined]);
  expect(h.upload).toHaveBeenCalledTimes(1);
  expect(h.rpc).toHaveBeenCalledTimes(3);
});

it("leaves candidate cleanup durable after upload failure without activating or finalizing original", async () => {
  h.upload.mockResolvedValue({ error: { message: "private storage detail" } });
  await expect(finalizeScreenshotUpload(input)).rejects.toThrow(/retry/i);
  expect(h.rpc).toHaveBeenCalledTimes(1);
  expect(console.info).not.toHaveBeenCalled();
});

it("does not fall back or delete a potentially committed candidate after activation failure", async () => {
  h.rpc.mockImplementation(async (name) => name === "reserve_screenshot_optimization"
    ? { data: { attempt_id: "attempt", storage_path: "private/candidate.webp" }, error: null }
    : { error: { message: "Access denied" } });
  await expect(finalizeScreenshotUpload(input)).rejects.toMatchObject({ message: "Access denied" });
  expect(h.rpc).toHaveBeenCalledTimes(2);
  expect(console.info).not.toHaveBeenCalled();
});
