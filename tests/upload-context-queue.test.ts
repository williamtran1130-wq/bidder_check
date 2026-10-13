import { afterEach, expect, it, vi } from "vitest";
import { UploadContextQueue } from "@/lib/upload-context-queue";

afterEach(() => vi.useRealTimers());

it("coalesces one page into one bounded read and maps null and failed files by ID", async () => {
  vi.useFakeTimers();
  const load = vi.fn(async (ids: string[]) => ({
    data: ids.map((id) =>
      id === "failed" ? { id, error: "Unavailable" } : { id, data: null },
    ),
  }));
  const queue = new UploadContextQueue(load);
  const a = queue.get("actor-a", "one");
  expect(queue.get("actor-a", "one")).toBe(a);
  const b = queue.get("actor-a", "failed");
  await vi.runAllTimersAsync();
  expect(load).toHaveBeenCalledExactlyOnceWith(["one", "failed"]);
  expect(await a).toMatchObject({ data: null });
  expect(await b).toMatchObject({ error: "Unavailable" });
  const fresh = queue.get("actor-a", "one");
  await vi.runAllTimersAsync();
  expect(await fresh).toMatchObject({ data: null });
  expect(load).toHaveBeenCalledTimes(2); // No persistent private-data cache.
});

it("separates actors and splits batches at 100 IDs", async () => {
  vi.useFakeTimers();
  const load = vi.fn(async (ids: string[]) => ({
    data: ids.map((id) => ({ id, data: null })),
  }));
  const queue = new UploadContextQueue(load);
  const pending = Array.from({ length: 101 }, (_, i) =>
    queue.get("actor-a", String(i)),
  );
  pending.push(queue.get("actor-b", "0"));
  await vi.runAllTimersAsync();
  await Promise.all(pending);
  expect(load.mock.calls.map(([ids]) => ids.length)).toEqual([100, 1, 1]);
});

it("drops unsent requests on access revocation and ignores old in-flight results", async () => {
  vi.useFakeTimers();
  let finish!: (value: { data: { id: string; data: null }[] }) => void;
  const load = vi.fn(
    () =>
      new Promise<{ data: { id: string; data: null }[] }>((r) => {
        finish = r;
      }),
  );
  const queue = new UploadContextQueue(load);
  const unsent = queue.get("actor-a", "unsent");
  queue.reset();
  await vi.runAllTimersAsync();
  expect(load).not.toHaveBeenCalled();
  expect(await unsent).toHaveProperty("error");
  const old = queue.get("actor-a", "old");
  await vi.advanceTimersByTimeAsync(16);
  queue.reset();
  finish({ data: [{ id: "old", data: null }] });
  expect(await old).toHaveProperty("error");
});

it("settles every cell on a thrown batch error and lets the next attempt recover", async () => {
  vi.useFakeTimers();
  let fail = true;
  const queue = new UploadContextQueue(async (ids) => {
    if (fail) throw Error("Network failed");
    return { data: ids.map((id) => ({ id, data: null })) };
  });
  const first = queue.get("actor-a", "one");
  await vi.runAllTimersAsync();
  expect(await first).toHaveProperty("error");
  fail = false;
  const retry = queue.get("actor-a", "one");
  await vi.runAllTimersAsync();
  expect(await retry).toMatchObject({ data: null });
});
