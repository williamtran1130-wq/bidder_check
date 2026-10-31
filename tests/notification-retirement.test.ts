import { expect, it, vi } from "vitest";
import { POST } from "@/app/api/cron/notifications/route";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { retirePushWorker } from "@/lib/retire-push-worker";
vi.mock("server-only", () => ({}));

it("retires the delivery endpoint without requiring credentials", async () => {
  const response = await POST(new Request("https://example.test/api/cron/notifications", { method: "POST" }));
  expect(response.status).toBe(410);
  expect(await response.json()).toEqual({ error: "Notifications have been retired." });
});

it("cleans only the former notification worker and preserves unrelated registrations", async () => {
  const registration = (scriptURL: string) => ({
    active: { scriptURL }, waiting: null, installing: null,
    pushManager: { getSubscription: vi.fn(async () => ({ unsubscribe: vi.fn(async () => true) })) },
    unregister: vi.fn(async () => true),
  });
  const retired = registration("https://example.test/push-worker.js");
  const other = registration("https://example.test/app-worker.js");
  const foreign = registration("https://other.test/push-worker.js");
  const migrating = { ...registration("https://example.test/push-worker.js"), waiting: { scriptURL: "https://example.test/app-worker.js" } };
  await retirePushWorker([retired, other, foreign, migrating] as unknown as ServiceWorkerRegistration[], "https://example.test");
  expect(retired.unregister).toHaveBeenCalledOnce();
  expect(retired.pushManager.getSubscription).toHaveBeenCalledOnce();
  expect(other.unregister).not.toHaveBeenCalled();
  expect(other.pushManager.getSubscription).not.toHaveBeenCalled();
  expect(foreign.unregister).not.toHaveBeenCalled();
  expect(migrating.unregister).not.toHaveBeenCalled();
});

it("the retirement worker unsubscribes its own push endpoint and unregisters itself", async () => {
  const unsubscribe = vi.fn(async () => true);
  const unregister = vi.fn(async () => true);
  const events: Record<string, (event: { waitUntil: (work: Promise<unknown>) => void }) => void> = {};
  const showNotification = vi.fn();
  runInNewContext(readFileSync("public/push-worker.js", "utf8"), {
    self: {
      addEventListener: (name: string, handler: typeof events[string]) => { events[name] = handler; },
      skipWaiting: async () => {},
      registration: { pushManager: { getSubscription: async () => ({ unsubscribe }) }, unregister, showNotification },
    },
  });
  let work: Promise<unknown> = Promise.resolve();
  events.activate({ waitUntil: (pending) => { work = pending; } });
  await work;
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(unregister).toHaveBeenCalledOnce();
  expect(events.push).toBeUndefined();
  expect(showNotification).not.toHaveBeenCalled();
});
