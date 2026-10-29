import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ rpc: vi.fn(), remove: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin", () => ({
  adminClient: () => ({
    rpc: fake.rpc,
    storage: { from: () => ({ remove: fake.remove }) },
  }),
}));
import { GET } from "@/app/api/cron/storage-cleanup/route";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubEnv("CRON_SECRET", "test");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
const request = (signal?: AbortSignal) =>
  new Request("https://test.invalid/api/cron/storage-cleanup", {
    headers: { authorization: "Bearer test" },
    signal,
  });
it("bounds the former seventy-four-second retention/removal/completion chain at fifty seconds from entry", async () => {
  let lateCompletion = false;
  fake.rpc.mockImplementation(async (name: string) => {
    if (name === "process_screenshot_retention" || name === "process_legacy_file_cleanup") return {data:{},error:null};
    await new Promise((resolve) => setTimeout(resolve, 14800));
    if (name === "process_candidate_retention")
      return { data: { deletedApplications: 1 }, error: null };
    if (name === "claim_storage_cleanup")
      return {
        data: [{ id: "task", lease_id: "lease", storage_path: "private/path" }],
        error: null,
      };
    if (name === "finish_storage_cleanup_batch") lateCompletion = true;
    return { data: { pending: 0 }, error: null };
  });
  fake.remove.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 14800));
    return { error: null };
  });
  let status: number | undefined;
  const response = GET(request()).then((value) => {
    status = value.status;
    return value;
  });
  await vi.advanceTimersByTimeAsync(50001);
  expect(status).toBe(503);
  expect(await (await response).json()).toEqual({
    error: "Cleanup pending; retry scheduled",
  });
  expect(fake.rpc.mock.calls.map(([name]) => name)).toEqual([
    "process_candidate_retention",
    "process_screenshot_retention",
    "process_legacy_file_cleanup",
    "claim_storage_cleanup",
    "finish_storage_cleanup_batch",
  ]);
  expect(lateCompletion).toBe(false);
  await vi.advanceTimersByTimeAsync(25000);
  expect(lateCompletion).toBe(true);
  expect(fake.remove).toHaveBeenCalledOnce();
  expect(
    fake.rpc.mock.calls.filter(([name]) => name === "claim_storage_cleanup"),
  ).toHaveLength(1);
});
it("does not acknowledge an uncertain stalled removal as successful after expiry", async () => {
  fake.rpc.mockImplementation(async (name: string) =>
    name === "claim_storage_cleanup"
      ? {
          data: [
            { id: "task", lease_id: "lease", storage_path: "private/path" },
          ],
          error: null,
        }
      : { data: {}, error: null },
  );
  let settleRemoval!: () => void;
  fake.remove.mockImplementation(
    () =>
      new Promise((resolve) => {
        settleRemoval = () => resolve({ error: null });
      }),
  );
  const response = GET(request());
  await vi.advanceTimersByTimeAsync(15100);
  expect((await response).status).toBe(200);
  expect(
    fake.rpc.mock.calls.find(
      ([name]) => name === "finish_storage_cleanup_batch",
    )?.[1].p_success,
  ).toBe(false);
  settleRemoval();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    fake.rpc.mock.calls.filter(
      ([name]) => name === "finish_storage_cleanup_batch",
    ),
  ).toHaveLength(1);
});
it("includes caller cancellation during retention and starts no cleanup work afterward", async () => {
  fake.rpc.mockImplementation(() => new Promise(() => {}));
  const caller = new AbortController();
  const response = GET(request(caller.signal));
  caller.abort(new Error("caller cancelled"));
  await vi.advanceTimersByTimeAsync(0);
  expect((await response).status).toBe(503);
  expect(fake.rpc.mock.calls.map(([name]) => name)).toEqual([
    "process_candidate_retention",
  ]);
  expect(fake.remove).not.toHaveBeenCalled();
});
