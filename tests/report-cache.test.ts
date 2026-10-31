import { expect, it, vi } from "vitest";
import { ReportCache, REPORT_FRESH_MS } from "@/lib/report-cache";

it("shares requests and reuses fresh values until the 270-second deadline", async () => {
  let now = 0;
  const cache = new ReportCache(() => now);
  const read = vi.fn(async () => ({ data: { found: 3 } }));
  const [a, b] = await Promise.all([cache.load("actor:report", read), cache.load("actor:report", read)]);
  expect(a).toEqual(b); expect(read).toHaveBeenCalledTimes(1);
  now = REPORT_FRESH_MS - 1; await cache.load("actor:report", read); expect(read).toHaveBeenCalledTimes(1);
  now++; await cache.load("actor:report", read); expect(read).toHaveBeenCalledTimes(2);
  await cache.load("actor:report", read, true); expect(read).toHaveBeenCalledTimes(3);
});
it("cannot repopulate private state after invalidation and bounds memory", async () => {
  const cache = new ReportCache(() => 0, 2);
  let resolve!: (value: { data: number }) => void;
  const pending = cache.load("old", () => new Promise<{ data: number }>(r => { resolve = r; }));
  await Promise.resolve(); cache.clear(); resolve({ data: 1 }); await pending;
  expect(cache.peek("old")).toBeUndefined();
  cache.seed("a", { data: 1 }); cache.seed("b", { data: 2 }); cache.seed("c", { data: 3 });
  expect(cache.peek("a")).toBeUndefined(); expect(cache.peek("c")).toMatchObject({ data: 3 });
});
it("does not cache errors or mix actor/query keys", async () => {
  const cache = new ReportCache();
  const read = vi.fn(async () => ({ error: "Unavailable" }));
  await cache.load("one", read); await cache.load("one", read); expect(read).toHaveBeenCalledTimes(2);
  cache.seed("owner:one", { data: 1 }); expect(cache.peek("bidder:one")).toBeUndefined();
});
it("manual refresh starts a new read and an older response cannot replace its cache", async () => {
  const cache = new ReportCache();
  let old!: (value: { data: number }) => void;
  const first = cache.load("same", () => new Promise<{ data: number }>(resolve => { old = resolve; }));
  await Promise.resolve();
  const readFresh = vi.fn(async () => ({ data: 2 }));
  const refreshed = cache.load("same", readFresh, true);
  await Promise.resolve();
  expect(readFresh).toHaveBeenCalledOnce();
  const fresh = await refreshed;
  expect(fresh).toEqual({ data: 2 });
  old({ data: 1 }); await first;
  expect(cache.peek("same")).toEqual({ data: 2 });
});
