import { afterEach, expect, it, vi } from "vitest";
const { worker, adminRpc } = vi.hoisted(() => ({
  worker: vi.fn(),
  adminRpc: vi.fn(),
}));
vi.mock("@/lib/storage-cleanup", () => ({ runStorageCleanup: worker }));
vi.mock("@/lib/admin", () => ({ adminClient: () => ({ rpc: adminRpc }) }));
import { GET } from "@/app/api/cron/storage-cleanup/route";
afterEach(() => {
  vi.unstubAllEnvs();
  worker.mockReset();
  adminRpc.mockReset();
});
const mockRetention = () => {
  adminRpc
    .mockResolvedValueOnce({
      data: { deletedApplications: 0, storageTasksQueued: 0 },
      error: null,
    })
    .mockResolvedValueOnce({
      data: { pending: 0, verificationPending: 0 },
      error: null,
    });
};
it("requires the exact server secret and fails closed when unconfigured", async () => {
  vi.stubEnv("CRON_SECRET", "");
  expect(
    (await GET(new Request("https://app/api/cron/storage-cleanup"))).status,
  ).toBe(401);
  vi.stubEnv("CRON_SECRET", "a-secret");
  expect(
    (
      await GET(
        new Request("https://app/api/cron/storage-cleanup", {
          headers: { authorization: "Bearer wrong" },
        }),
      )
    ).status,
  ).toBe(401);
  expect(worker).not.toHaveBeenCalled();
  worker.mockResolvedValue({ attempted: 2, succeeded: 2, failed: 0 });
  mockRetention();
  expect(
    (
      await GET(
        new Request("https://app/api/cron/storage-cleanup", {
          headers: { authorization: "Bearer a-secret" },
        }),
      )
    ).status,
  ).toBe(200);
  expect(worker).toHaveBeenCalledOnce();
});
it("drains multiple batches within the function limit and reports a pending retry on failure", async () => {
  vi.stubEnv("CRON_SECRET", "a-secret");
  const call = () =>
    GET(
      new Request("https://app/api/cron/storage-cleanup", {
        headers: { authorization: "Bearer a-secret" },
      }),
    );
  worker.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
  mockRetention();
  await call();
  expect(worker).toHaveBeenCalledWith(undefined, {
    maxBatches: expect.any(Number),
    deadlineAt: expect.any(Number),
    signal: expect.any(AbortSignal),
  });
  expect(worker.mock.calls[0][1].maxBatches).toBeGreaterThan(1);
  worker.mockRejectedValue(new Error("db down"));
  mockRetention();
  const failed = await call();
  expect(failed.status).toBe(503);
  expect(JSON.stringify(await failed.json())).not.toMatch(/db down/);
});
