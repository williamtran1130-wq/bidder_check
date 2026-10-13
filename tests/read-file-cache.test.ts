import { expect, it, vi, afterEach } from "vitest";
import { existsSync } from "node:fs";
afterEach(() => vi.useRealTimers());
it("coalesces visible files per actor, expires before sixty seconds, and drops old actor responses", async () => {
  expect(existsSync("src/lib/file-url-cache.ts")).toBe(true);
  const { FileUrlQueue } = await import("@/lib/file-url-cache");
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const finishes: ((value: {
    data: import("@/lib/read-types").FileUrlOutcome[];
  }) => void)[] = [];
  const load = vi.fn(
    () =>
      new Promise<{ data: import("@/lib/read-types").FileUrlOutcome[] }>(
        (resolve) => finishes.push(resolve),
      ),
  );
  const queue = new FileUrlQueue(load);
  const a = queue.get("actor-a", "file-a");
  const b = queue.get("actor-a", "file-b");
  await vi.advanceTimersByTimeAsync(20);
  expect(load).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledWith(["file-a", "file-b"]);
  finishes[0]({
    data: [
      {
        id: "file-a",
        data: {
          url: "a",
          name: "a",
          mime: "image/png",
          expiresAt: new Date(160000).toISOString(),
        },
      },
      { id: "file-b", error: "Missing" },
    ],
  });
  expect(await a).toMatchObject({ data: { url: "a" } });
  expect(await b).toMatchObject({ error: "Missing" });
  expect(await queue.get("actor-a", "file-a")).toMatchObject({
    data: { url: "a" },
  });
  expect(load).toHaveBeenCalledTimes(1);
  queue.invalidate("actor-a", "file-a");
  const replaced = queue.get("actor-a", "file-a");
  await vi.advanceTimersByTimeAsync(20);
  expect(load).toHaveBeenCalledTimes(2);
  queue.reset();
  finishes[1]({
    data: [
      {
        id: "file-a",
        data: {
          url: "old",
          name: "old",
          mime: "image/png",
          expiresAt: new Date(160000).toISOString(),
        },
      },
    ],
  });
  expect(await replaced).toMatchObject({ error: expect.any(String) });
});
it("separates actor caches, refreshes before URL expiry, and splits batches at100", async () => {
  const { FileUrlQueue } = await import("@/lib/file-url-cache");
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const load = vi.fn(async (ids: string[]) => ({
    data: ids.map((id) => ({
      id,
      data: {
        url: `signed-${load.mock.calls.length}`,
        name: id,
        mime: "image/png",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    })),
  }));
  const queue = new FileUrlQueue(load);
  const a = queue.get("a", "same");
  await vi.advanceTimersByTimeAsync(20);
  expect((await a).data?.url).toBe("signed-1");
  const b = queue.get("b", "same");
  await vi.advanceTimersByTimeAsync(20);
  expect((await b).data?.url).toBe("signed-2");
  vi.setSystemTime(146000);
  const expiry = queue.get("a", "same");
  await vi.advanceTimersByTimeAsync(20);
  expect((await expiry).data?.url).toBe("signed-3");
  const bulk = Array.from({ length: 101 }, (_, i) => queue.get("c", String(i)));
  await vi.advanceTimersByTimeAsync(20);
  await Promise.all(bulk);
  expect(load.mock.calls.slice(3).map(([ids]) => ids.length)).toEqual([100, 1]);
});
