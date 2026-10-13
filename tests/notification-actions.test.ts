import "./server-only-mock";
import { afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  rpc: vi.fn(),
  profile: { role: "client" },
  workspaces: [{ id: "00000000-0000-4000-8000-000000000001" }],
}));
vi.mock("@/lib/auth", () => ({
  getContext: async () => ({
    supabase: { rpc: fake.rpc },
    profile: fake.profile,
    workspaces: fake.workspaces,
  }),
}));
import {
  saveNotificationMessage,
  previewNotificationSchedule,
  getNotificationPage,
} from "@/app/(workspace)/notification-actions";
afterEach(() => vi.resetAllMocks());
it("now needs no date and failures remain unavailable rather than empty success", async () => {
  fake.rpc.mockResolvedValueOnce({ data: { id: "saved" }, error: null });
  const result = await saveNotificationMessage({
    workspace_id: fake.workspaces[0].id,
    title: "Update",
    body: "Body",
    recipient_mode: "all",
    recipient_ids: [],
    schedule: { kind: "now" },
    draft: true,
  });
  expect(result.data).toMatchObject({ id: "saved" });
  expect(fake.rpc.mock.calls[0][1].p_input).toMatchObject({
    schedule: { kind: "now" },
    draft: true,
  });
  fake.rpc.mockResolvedValueOnce({
    data: null,
    error: { message: "Database temporarily unavailable" },
  });
  expect(await getNotificationPage({ kind: "inbox" })).toEqual({
    error: "Notifications are unavailable. Please retry.",
  });
});

it("keeps known schedule validation readable and hides backend details", async () => {
  fake.rpc.mockResolvedValueOnce({
    data: null,
    error: { message: "Choose a future send time or Send now", code: "P0001" },
  });
  expect(
    (
      await previewNotificationSchedule({
        kind: "once",
        scheduled_local: "2020-01-01T09:00",
      })
    ).error,
  ).toBe("Choose a future send time or Send now");
  fake.rpc.mockResolvedValueOnce({
    data: null,
    error: {
      message: "canceling statement due to statement timeout",
      code: "57014",
    },
  });
  expect((await getNotificationPage({ kind: "messages" })).error).toBe(
    "Notifications are unavailable. Please retry.",
  );
});
it("preview forwards the same typed schedule to the database resolver", async () => {
  fake.rpc.mockResolvedValueOnce({
    data: { next_at: "2026-11-01T06:30:00Z", timezone: "America/Chicago" },
    error: null,
  });
  expect(
    (
      await previewNotificationSchedule({
        kind: "once",
        scheduled_local: "2026-11-01T01:30",
      })
    ).data?.next_at,
  ).toBe("2026-11-01T06:30:00Z");
  expect(fake.rpc.mock.calls[0]).toEqual([
    "preview_notification_schedule",
    { p_schedule: { kind: "once", scheduled_local: "2026-11-01T01:30" } },
  ]);
});
