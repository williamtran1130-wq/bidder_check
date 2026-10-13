import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { rpc, remove, worker } = vi.hoisted(() => ({
  rpc: vi.fn(),
  remove: vi.fn(),
  worker: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin", () => ({
  adminClient: () => ({ rpc, storage: { from: () => ({ remove }) } }),
}));
import { runStorageCleanup } from "@/lib/storage-cleanup";
beforeEach(() => {
  rpc.mockReset();
  remove.mockReset();
  worker.mockReset();
});
it("removes objects through Storage and records failures for a later retry", async () => {
  rpc
    .mockResolvedValueOnce({
      data: [{ id: "task", lease_id: "lease", storage_path: "private/path" }],
    })
    .mockResolvedValue({ error: null });
  remove.mockResolvedValue({ error: { message: "Storage offline" } });
  expect(await runStorageCleanup("operation")).toEqual({
    attempted: 1,
    succeeded: 0,
    failed: 1,
  });
  expect(remove).toHaveBeenCalledWith(["private/path"]);
  expect(rpc).toHaveBeenLastCalledWith("finish_storage_cleanup_batch", {
    p_tasks: ["task"],
    p_leases: ["lease"],
    p_success: false,
  });
});
it("does not mark a rejected Storage request successful", async () => {
  rpc
    .mockResolvedValueOnce({
      data: [{ id: "task", lease_id: "lease", storage_path: "private/path" }],
    })
    .mockResolvedValue({ error: null });
  remove.mockRejectedValue(new Error("Network timeout"));
  await runStorageCleanup();
  expect(rpc).toHaveBeenLastCalledWith("finish_storage_cleanup_batch", {
    p_tasks: ["task"],
    p_leases: ["lease"],
    p_success: false,
  });
});
it("passes successful removal to the database verification state", async () => {
  rpc
    .mockResolvedValueOnce({
      data: [{ id: "task", lease_id: "lease", storage_path: "private/path" }],
    })
    .mockResolvedValue({ error: null });
  remove.mockResolvedValue({ error: null });
  await runStorageCleanup();
  expect(rpc).toHaveBeenLastCalledWith("finish_storage_cleanup_batch", {
    p_tasks: ["task"],
    p_leases: ["lease"],
    p_success: true,
  });
});
const batch = (n: number, prefix = "p") =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    lease_id: `l${i}`,
    storage_path: `private/${prefix}${i}`,
  }));
it("drains backlogs larger than 50 files across bounded batches when allowed", async () => {
  rpc.mockImplementation(async (name: string) => {
    if (name !== "claim_storage_cleanup") return { error: null };
    return {
      data: [batch(50, "a"), batch(50, "b"), batch(7, "c"), []][
        rpc.mock.calls.filter(([n]) => n === "claim_storage_cleanup").length - 1
      ],
    };
  });
  remove.mockResolvedValue({ error: null });
  expect(await runStorageCleanup(undefined, { maxBatches: 20 })).toEqual({
    attempted: 107,
    succeeded: 107,
    failed: 0,
  });
  expect(remove).toHaveBeenCalledTimes(3);
});
it("runs a single bounded pass by default", async () => {
  rpc.mockResolvedValueOnce({ data: batch(50) }).mockResolvedValue({
    error: null,
  });
  remove.mockResolvedValue({ error: null });
  expect((await runStorageCleanup()).attempted).toBe(50);
  expect(
    rpc.mock.calls.filter(([n]) => n === "claim_storage_cleanup"),
  ).toHaveLength(1);
});
it("does nothing when another worker holds every lease", async () => {
  rpc.mockResolvedValue({ data: [] });
  expect(await runStorageCleanup("operation")).toEqual({
    attempted: 0,
    succeeded: 0,
    failed: 0,
  });
  expect(remove).not.toHaveBeenCalled();
});
it("throws when tasks cannot be claimed, before touching Storage", async () => {
  rpc.mockResolvedValue({ error: { message: "db down" } });
  await expect(runStorageCleanup()).rejects.toThrow(/pending/i);
  expect(remove).not.toHaveBeenCalled();
});
it("throws when a result cannot be recorded, leaving the lease to expire", async () => {
  rpc
    .mockResolvedValueOnce({ data: batch(1) })
    .mockResolvedValue({ error: { message: "db down" } });
  remove.mockResolvedValue({ error: null });
  await expect(runStorageCleanup()).rejects.toThrow(/pending/i);
});
it("logs counts only, never file paths or Storage error text", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  rpc.mockResolvedValueOnce({ data: batch(1) }).mockResolvedValue({
    error: null,
  });
  remove.mockResolvedValue({ error: { message: "secret private/p0 detail" } });
  await runStorageCleanup();
  const logged = JSON.stringify([...log.mock.calls, ...info.mock.calls]);
  expect(logged).not.toMatch(/private|secret/);
  log.mockRestore();
  info.mockRestore();
});

afterEach(() => vi.useRealTimers());
it("uses one shared absolute deadline and reserves five seconds before claiming more work", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  rpc.mockImplementation(async (name: string) => {
    if (name === "claim_storage_cleanup") {
      await new Promise((resolve) => setTimeout(resolve, 14000));
      return { data: batch(50), error: null };
    }
    await new Promise((resolve) => setTimeout(resolve, 14000));
    return { error: null };
  });
  remove.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 14000));
    return { error: null };
  });
  const result = runStorageCleanup(undefined, {
    maxBatches: 20,
    deadlineAt: 50000,
  });
  let settled = false;
  const observed = result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.advanceTimersByTimeAsync(50001);
  expect(settled).toBe(true);
  await observed;
  expect(
    rpc.mock.calls.filter(([name]) => name === "claim_storage_cleanup"),
  ).toHaveLength(2);
  expect(remove).toHaveBeenCalledOnce();
});
it("does not begin a claim inside the deadline's five-second completion reserve", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(46000);
  expect(
    await runStorageCleanup(undefined, { maxBatches: 20, deadlineAt: 50000 }),
  ).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
  expect(rpc).not.toHaveBeenCalled();
});
it("acknowledges a known successful batch once with every task's lease", async () => {
  rpc
    .mockResolvedValueOnce({ data: batch(50) })
    .mockResolvedValue({ error: null });
  remove.mockResolvedValue({ error: null });
  expect(await runStorageCleanup()).toEqual({
    attempted: 50,
    succeeded: 50,
    failed: 0,
  });
  const finishes = rpc.mock.calls.filter(
    ([name]) => name !== "claim_storage_cleanup",
  );
  expect(finishes).toEqual([
    [
      "finish_storage_cleanup_batch",
      {
        p_tasks: Array.from({ length: 50 }, (_, i) => `p${i}`),
        p_leases: Array.from({ length: 50 }, (_, i) => `l${i}`),
        p_success: true,
      },
    ],
  ]);
});
it("does not infer per-object success from an errored removal response", async () => {
  rpc
    .mockResolvedValueOnce({ data: batch(2) })
    .mockResolvedValue({ error: null });
  remove.mockResolvedValue({
    data: [{ name: "private/p0" }],
    error: { message: "partial or uncertain" },
  });
  expect(await runStorageCleanup()).toEqual({
    attempted: 2,
    succeeded: 0,
    failed: 2,
  });
  expect(rpc).toHaveBeenLastCalledWith("finish_storage_cleanup_batch", {
    p_tasks: ["p0", "p1"],
    p_leases: ["l0", "l1"],
    p_success: false,
  });
});
