import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  notificationResource,
  discardNotificationScope,
} from "@/lib/notification-store";
beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
});
afterEach(() => {
  discardNotificationScope("fix1:");
  vi.unstubAllGlobals();
});
it("only an accepted fresh seed skips the initial read, including effect replays and active consumers", async () => {
  const load = vi.fn(async () => ({ data: 2 }));
  const resource = notificationResource("fix1:fresh", load, { data: 1 });
  const owner = {};
  let stop = resource.subscribe(() => {});
  await resource.mount(owner);
  stop();
  stop = resource.subscribe(() => {});
  await resource.mount(owner);
  const other = notificationResource("fix1:fresh", load, { data: 99 });
  const stopOther = other.subscribe(() => {});
  await other.mount({});
  expect(load).not.toHaveBeenCalled();
  expect(resource.snapshot().data).toBe(1);
  stop();
  stopOther();
});
it("returning concurrent consumers reconcile ignored seeds once and mutation invalidation wins", async () => {
  const resolvers: ((result: { data: number }) => void)[] = [];
  const load = vi.fn(
    () => new Promise<{ data: number }>((resolve) => resolvers.push(resolve)),
  );
  const resource = notificationResource("fix1:back", load, { data: 1 });
  const stop = resource.subscribe(() => {});
  await resource.mount({});
  stop();
  const returning = notificationResource("fix1:back", load, { data: 2 });
  const stopA = returning.subscribe(() => {}),
    stopB = returning.subscribe(() => {});
  const first = returning.mount({}),
    second = returning.mount({});
  expect(first).toBe(second);
  expect(load).toHaveBeenCalledTimes(1);
  expect(returning.snapshot().data).toBe(1);
  const mutation = returning.refresh(true);
  expect(load).toHaveBeenCalledTimes(2);
  resolvers[1]({ data: 3 });
  await mutation;
  resolvers[0]({ data: 2 });
  await first;
  expect(returning.snapshot().data).toBe(3);
  stopA();
  stopB();
});
it("a fresh initial error is not retried automatically but a returning ignored seed is reconciled", async () => {
  const load = vi.fn(async () => ({ data: 4 }));
  const resource = notificationResource("fix1:error", load, {
    error: "Unavailable",
  });
  const stop = resource.subscribe(() => {});
  await resource.mount({});
  expect(load).not.toHaveBeenCalled();
  stop();
  const returning = notificationResource("fix1:error", load, { data: 4 });
  const stopAgain = returning.subscribe(() => {});
  await returning.mount({});
  expect(load).toHaveBeenCalledOnce();
  expect(returning.snapshot()).toEqual({ data: 4 });
  stopAgain();
});
it("resumes a retained consumer after an inactive turn with one reconciliation read", async () => {
  const load = vi.fn(async () => ({ data: 5 }));
  const resource = notificationResource("fix1:retained", load, { data: 1 });
  const owner = {};
  const stop = resource.subscribe(() => {});
  await resource.mount(owner);
  stop();
  await Promise.resolve();
  const stopAgain = resource.subscribe(() => {});
  await resource.mount(owner);
  expect(load).toHaveBeenCalledOnce();
  expect(resource.snapshot().data).toBe(5);
  stopAgain();
});
