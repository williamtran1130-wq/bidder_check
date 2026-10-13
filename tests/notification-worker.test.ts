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

it("never reclassifies an accepted push as a failed send when completion acknowledgement is lost", async () => {
  queue(1);
  fake.send.mockResolvedValue({ statusCode: 201 });
  const original = fake.rpc.getMockImplementation()!;
  let completion = 0;
  fake.rpc.mockImplementation((name: string, args?: { p_limit?: number }) =>
    name === "finish_push_attempt" && ++completion === 1
      ? Promise.resolve({ error: { message: "SQL acknowledgement lost" } })
      : original(name, args),
  );
  const result = await (await call()).json();
  expect(result).toMatchObject({ accepted: 1, retried: 0 });
  expect(fake.send).toHaveBeenCalledOnce();
  const acknowledgements = fake.rpc.mock.calls.filter(
    ([name]) => name === "finish_push_attempt",
  );
  expect(acknowledgements).toHaveLength(2);
  expect(
    acknowledgements.every(
      ([, args]) => args.p_error === null && args.p_expired === false,
    ),
  ).toBe(true);
});

it("settles a slow sibling after another completion RPC rejects before responding", async () => {
  queue(2);
  let sends = 0;
  let resolveSlow!: () => void;
  fake.send.mockImplementation(() =>
    ++sends === 1
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          resolveSlow = resolve;
        }),
  );
  const original = fake.rpc.getMockImplementation()!;
  fake.rpc.mockImplementation((name: string, args?: { p_limit?: number }) =>
    name === "finish_push_attempt"
      ? Promise.reject(new Error("completion unavailable"))
      : original(name, args),
  );
  let returned = false;
  const response = call().then((value) => {
    returned = true;
    return value;
  });
  await vi.waitFor(() => expect(sends).toBe(2));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(returned).toBe(false);
  resolveSlow();
  expect((await response).status).toBe(503);
});

it("bounds the serialized UTF-8 push preview including title and href while retaining a stable notification identity", async () => {
  queue(1);
  const originalRpc = fake.rpc.getMockImplementation()!;
  fake.rpc.mockImplementation(
    async (name: string, args?: { p_limit?: number }) => {
      const result = await originalRpc(name, args);
      if (name === "claim_push_attempts")
        result.data.forEach((row: { title: string; body: string }) => {
          row.title = "\u{1f469}\u{1f3fd}\u200d\u{1f4bb}".repeat(900);
          row.body = "\u6f22\u5b57\u0022\n".repeat(1800);
        });
      return result;
    },
  );
  const originalFrom = fake.from.getMockImplementation()!;
  fake.from.mockImplementation((table: string) => {
    const query = originalFrom(table);
    if (table === "inbox_notifications")
      query.maybeSingle = async () => ({
        data: {
          kind: "client_signup",
          user_id: "recipient",
          resolved_at: null,
          href: "/notifications?long=" + "\u{1f4ac}".repeat(3000),
          created_at: "2026-10-12T15:00:00Z",
        },
        error: null,
      });
    return query;
  });
  fake.send.mockResolvedValue({ statusCode: 201 });
  expect((await call()).status).toBe(200);
  const payload = fake.send.mock.calls[0][1];
  expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(3072);
  const preview = JSON.parse(payload);
  expect(preview.notificationId).toBe("notice");
  expect(preview.url).toBe("/notifications?notification=notice");
  expect(preview.title).not.toContain("\ufffd");
  expect(preview.body).not.toContain("\ufffd");
  expect(
    fake.from.mock.calls.every(([table]) =>
      ["inbox_notifications", "profiles", "push_subscriptions"].includes(table),
    ),
  ).toBe(true);
});

it.each([400, 403, 404, 410, 429, 500])(
  "preserves retry/device-expiry policy for provider status %s",
  async (statusCode) => {
    queue(1);
    fake.send.mockRejectedValue({ statusCode });
    expect(await (await call()).json()).toMatchObject({
      accepted: 0,
      retried: 1,
    });
    expect(fake.rpc).toHaveBeenLastCalledWith("claim_push_attempts", {
      p_limit: 5,
    });
    expect(
      fake.rpc.mock.calls.find(([name]) => name === "finish_push_attempt")?.[1],
    ).toMatchObject({
      p_error: "Push provider request failed",
      p_expired: statusCode === 404 || statusCode === 410,
    });
  },
);
it("leaves an accepted push pending after both success acknowledgements fail, without sending again", async () => {
  queue(1);
  fake.send.mockResolvedValue({ statusCode: 201 });
  const original = fake.rpc.getMockImplementation()!;
  fake.rpc.mockImplementation((name: string, args?: { p_limit?: number }) =>
    name === "finish_push_attempt"
      ? Promise.resolve({ error: { message: "completion unavailable" } })
      : original(name, args),
  );
  const response = await call();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    accepted: 1,
    completionPending: 1,
  });
  expect(fake.send).toHaveBeenCalledOnce();
  expect(
    fake.rpc.mock.calls
      .filter(([name]) => name === "finish_push_attempt")
      .every(([, args]) => args.p_error === null && !args.p_expired),
  ).toBe(true);
});
it.each(["membership", "owner"])(
  "rechecks archived membership and owner approval before message sends (%s)",
  async (revoked) => {
    queue(1);
    fake.from.mockImplementation((table: string) => {
      let identity = "";
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => {
          identity = value;
          return query;
        },
        maybeSingle: async () => {
          const values: Record<string, unknown> = {
            inbox_notifications: {
              kind: "message",
              user_id: "recipient",
              resolved_at: null,
              href: null,
              created_at: "2026-10-12T15:00:00Z",
            },
            profiles:
              identity === "owner"
                ? {
                    archived: false,
                    approval_status:
                      revoked === "owner" ? "rejected" : "approved",
                  }
                : {
                    role: "bidder",
                    archived: false,
                    approval_status: "approved",
                  },
            push_subscriptions: {
              user_id: "recipient",
              p256dh: "key",
              auth_secret: "auth",
              created_at: "2026-10-12T14:00:00Z",
            },
            bidders: {
              workspace_id: "workspace",
              archived: revoked === "membership",
            },
            workspaces: { owner_id: "owner" },
          };
          return { data: values[table], error: null };
        },
      };
      return query;
    });
    expect(await (await call()).json()).toMatchObject({
      accepted: 0,
      skipped: 1,
    });
    expect(fake.send).not.toHaveBeenCalled();
  },
);
