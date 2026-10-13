import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Agent } from "node:https";
import { Socket } from "node:net";
const fake = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  send: vi.fn(),
  vapid: vi.fn(),
}));
vi.mock("@/lib/admin", () => ({
  adminClient: () => ({ rpc: fake.rpc, from: fake.from }),
}));
vi.mock("web-push", () => ({
  default: { sendNotification: fake.send, setVapidDetails: fake.vapid },
}));
import { POST } from "@/app/api/cron/notifications/route";
const call = () =>
  POST(
    new Request("https://test.invalid/api/cron/notifications", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    }),
  );
beforeEach(() => {
  vi.stubEnv("NOTIFICATION_WORKER_SECRET", "test-secret");
  vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "test-public");
  vi.stubEnv("VAPID_PRIVATE_KEY", "test-private");
  vi.stubEnv("VAPID_SUBJECT", "mailto:test@test.invalid");
  fake.from.mockImplementation((table: string) => {
    const values: Record<string, object> = {
      inbox_notifications: {
        kind: "client_signup",
        user_id: "recipient",
        resolved_at: null,
        href: null,
        created_at: "2026-10-12T15:00:00Z",
      },
      profiles: { role: "admin", archived: false, approval_status: "approved" },
      push_subscriptions: {
        user_id: "recipient",
        p256dh: "key",
        auth_secret: "auth",
        created_at: "2026-10-12T14:00:00Z",
      },
    };
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: values[table], error: null }),
    };
    return query;
  });
});

it("skips devices newer than the notification and rotated device keys", async () => {
  queue(2);
  const original = fake.from.getMockImplementation()!;
  let devices = 0;
  fake.from.mockImplementation((table: string) => {
    const query = original(table);
    if (table === "push_subscriptions")
      query.maybeSingle = async () => ({
        data:
          ++devices === 1
            ? {
                user_id: "recipient",
                p256dh: "key",
                auth_secret: "auth",
                created_at: "2099-01-01T00:00:00Z",
              }
            : {
                user_id: "recipient",
                p256dh: "rotated",
                auth_secret: "new",
                created_at: "2020-01-01T00:00:00Z",
              },
        error: null,
      });
    return query;
  });
  expect(await (await call()).json()).toMatchObject({
    skipped: 2,
    accepted: 0,
  });
  expect(fake.send).not.toHaveBeenCalled();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.resetAllMocks();
});
function queue(total: number) {
  let remaining = total;
  fake.rpc.mockImplementation(
    async (name: string, args?: { p_limit?: number }) => {
      if (name !== "claim_push_attempts")
        return { data: { occurrences: 1 }, error: null };
      const count = Math.min(remaining, args?.p_limit ?? 100);
      remaining -= count;
      return {
        data: Array.from({ length: count }, (_, i) => ({
          attempt_id: `attempt-${remaining + i}`,
          lease_id: "lease",
          notification_id: "notice",
          endpoint: "https://push.test.invalid",
          p256dh: "key",
          auth_secret: "auth",
          title: "Update",
          body: "Body",
          user_id: "recipient",
        })),
        error: null,
      };
    },
  );
}
it("claims just in time, bounds concurrency to five and stops after 100 attempts", async () => {
  queue(120);
  let active = 0,
    max = 0;
  fake.send.mockImplementation(async () => {
    active++;
    max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
  });
  const response = await call();
  const result = await response.json();
  expect(result).toMatchObject({ claimed: 100, accepted: 100 });
  expect(max).toBeLessThanOrEqual(5);
  expect(
    fake.rpc.mock.calls
      .filter((c) => c[0] === "claim_push_attempts")
      .every((c) => c[1].p_limit === 5),
  ).toBe(true);
  expect(fake.send.mock.calls[0][2]).toMatchObject({ timeout: 5000 });
});
it("still publishes inboxes and retains queued push work without VAPID", async () => {
  queue(2);
  vi.stubEnv("VAPID_PRIVATE_KEY", "");
  expect(await (await call()).json()).toMatchObject({
    pushConfigured: false,
    accepted: 0,
  });
  expect(fake.rpc.mock.calls.map((c) => c[0])).toEqual([
    "process_due_messages",
    "queue_notification_pushes",
  ]);
  expect(fake.send).not.toHaveBeenCalled();
});
it("times out a stalled provider and leaves retryable durable work", async () => {
  vi.useFakeTimers();
  queue(5);
  fake.send.mockImplementation(() => new Promise(() => {}));
  const response = call();
  await vi.advanceTimersByTimeAsync(5100);
  expect(await (await response).json()).toMatchObject({
    claimed: 5,
    retried: 5,
  });
  expect(
    fake.rpc.mock.calls
      .filter((c) => c[0] === "finish_push_attempt")
      .every((c) => c[1].p_error === "Push provider request failed"),
  ).toBe(true);
});
it("stops claiming after its forty-second work budget", async () => {
  vi.useFakeTimers();
  queue(120);
  fake.send.mockImplementation(() => new Promise(() => {}));
  const response = call();
  await vi.advanceTimersByTimeAsync(45000);
  const result = await (await response).json();
  expect(result.claimed).toBeLessThanOrEqual(40);
  expect(result.retried).toBe(result.claimed);
});

it("bounds slow eligibility reads by the remaining budget and never sends after expiry", async () => {
  vi.useFakeTimers();
  queue(5);
  const original = fake.from.getMockImplementation()!;
  fake.from.mockImplementation((table: string) => {
    const query = original(table);
    const single = query.maybeSingle;
    query.maybeSingle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 14000));
      return single();
    };
    return query;
  });
  const response = call();
  await vi.advanceTimersByTimeAsync(40100);
  expect(await (await response).json()).toMatchObject({
    claimed: 5,
    retried: 5,
  });
  expect(fake.send).not.toHaveBeenCalled();
});

it("destroys stalled provider sockets before claiming the next batch", async () => {
  vi.useFakeTimers();
  queue(10);
  const sockets: Socket[] = [];
  let maximum = 0;
  fake.send.mockImplementation(
    (_subscription: unknown, _payload: string, options: { agent?: Agent }) => {
      const socket = new Socket();
      sockets.push(socket);
      const agent = options.agent ?? new Agent();
      Object.assign(agent.sockets, { "synthetic-provider": [socket] });
      maximum = Math.max(maximum, sockets.filter((s) => !s.destroyed).length);
      return new Promise(() => {});
    },
  );
  const original = fake.rpc.getMockImplementation()!;
  const activeAtClaim: number[] = [];
  fake.rpc.mockImplementation((name: string, args?: { p_limit?: number }) => {
    if (name === "claim_push_attempts")
      activeAtClaim.push(sockets.filter((s) => !s.destroyed).length);
    return original(name, args);
  });
  const response = call();
  await vi.advanceTimersByTimeAsync(10100);
  expect(await (await response).json()).toMatchObject({
    claimed: 10,
    retried: 10,
  });
  expect(maximum).toBeLessThanOrEqual(5);
  expect(activeAtClaim.every((count) => count === 0)).toBe(true);
  expect(sockets.every((socket) => socket.destroyed)).toBe(true);
});
