import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  notificationResource,
  refreshNotificationScope,
} from "@/lib/notification-store";
beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("shares an in-flight read and retains matching-scope data on errors", async () => {
  let finish: (r: { data?: number; error?: string }) => void = () => {};
  const load = vi.fn(
    () =>
      new Promise<{ data?: number; error?: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const resource = notificationResource("account-a:unread", load, { data: 7 });
  const sameResource = notificationResource("account-a:unread", load, {
    data: 99,
  });
  expect(sameResource).toBe(resource);
  const a = resource.refresh();
  const b = sameResource.refresh();
  expect(load).toHaveBeenCalledOnce();
  finish({ error: "Offline" });
  await Promise.all([a, b]);
  expect(resource.snapshot()).toMatchObject({ data: 7, error: "Offline" });
  expect(
    notificationResource("account-b:unread", async () => ({
      data: 2,
    })).snapshot().data,
  ).toBeUndefined();
});
it("refreshes only mounted resources in the matching account", async () => {
  let count = 0;
  const resource = notificationResource("account-c:messages", async () => ({
    data: ++count,
  }));
  const unsubscribe = resource.subscribe(() => {});
  await refreshNotificationScope("account-c:");
  expect(resource.snapshot().data).toBe(1);
  unsubscribe();
  await refreshNotificationScope("account-c:");
  expect(resource.snapshot().data).toBe(1);
});
it("drops private cached data on authorization denial even before new account props arrive", async () => {
  const resource = notificationResource(
    "denied-account:messages",
    async () => ({ error: "Access denied" }),
    { data: "previous private row" },
  );
  await resource.refresh();
  expect(resource.snapshot()).toEqual({ error: "Access denied" });
});

it("polls a shared resource once each thirty seconds only while foregrounded", async () => {
  vi.useFakeTimers();
  const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", doc);
  const load = vi.fn(async () => ({ data: 4 }));
  const resource = notificationResource("foreground-account:unread", load);
  const shell = resource.subscribe(() => {});
  const inbox = resource.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(30000);
  expect(load).not.toHaveBeenCalled();
  doc.visibilityState = "visible";
  await vi.advanceTimersByTimeAsync(30000);
  expect(load).toHaveBeenCalledOnce();
  shell();
  inbox();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
