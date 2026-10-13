import type {
  InboxNotification,
  NotificationMessage,
  NotificationPage,
  NotificationPreview,
  NotificationQuery,
  NotificationResult,
  NotificationSchedule,
  PushSubscriptionInput,
  SaveNotificationInput,
} from "@/lib/notification-types";
import { formatInTimeZone } from "date-fns-tz";
import { previewScheduleInstant } from "./notification-schedule";
import { fixture } from "./sample-data";
const scenario = new URLSearchParams(window.location.search).get(
  "notification-case",
);
const created = "2026-10-01T15:00:00Z";
let messages: NotificationMessage[] =
  scenario === "paused"
    ? [
        {
          id: "paused-message",
          workspace_id: fixture.workspaces[0].id,
          created_by: fixture.profile.id,
          title: "Daily reminder",
          body: "Authored reminder",
          recipient_mode: "all",
          recipient_ids: [],
          schedule_kind: "daily",
          scheduled_at: null,
          local_time: "10:15:00",
          weekdays: [],
          status: "paused",
          next_at: null,
          created_at: created,
          updated_at: created,
          send_on_publish: false,
          latest_publication: { published_at: created, recipient_count: 2 },
        },
      ]
    : [];
const notices: InboxNotification[] = Array.from(
  { length: scenario === "paged" ? 125 : 0 },
  (_, i) => ({
    id: `notice-${i}`,
    occurrence_id: null,
    user_id: fixture.profile.id,
    title: `Update ${i}`,
    body: "Authored message",
    created_at: created,
    read_at: null,
    kind: "message",
    client_id: null,
    href: null,
    resolved_at: null,
  }),
);
export async function previewNotificationSchedule(
  schedule: NotificationSchedule,
): Promise<NotificationResult<NotificationPreview>> {
  try {
    return {
      data: {
        next_at: previewScheduleInstant(schedule),
        timezone: "America/Chicago",
      },
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Choose a valid delivery schedule",
    };
  }
}
export async function saveNotificationMessage(
  input: SaveNotificationInput,
): Promise<NotificationResult<NotificationMessage>> {
  if (scenario === "save-throw") {
    window.dispatchEvent(new Event("fixture-notification-transport-attempt"));
    throw new Error("Simulated action transport disconnect");
  }
  if (scenario === "save-error")
    return { error: "Notifications are unavailable. Please retry." };
  window.dispatchEvent(
    new CustomEvent("fixture-notification-save", { detail: input }),
  );
  const old = messages.find((m) => m.id === input.id);
  const s = input.schedule;
  const preview = await previewNotificationSchedule(s);
  if (preview.error || !preview.data) return { error: preview.error };
  const row: NotificationMessage = {
    id: input.id ?? `message-${Date.now()}`,
    workspace_id: input.workspace_id,
    created_by: fixture.profile.id,
    title: input.title,
    body: input.body,
    recipient_mode: input.recipient_mode,
    recipient_ids: input.recipient_ids,
    schedule_kind: s.kind === "now" ? "once" : s.kind,
    scheduled_at:
      s.kind === "once"
        ? preview.data.next_at
        : s.kind === "now"
          ? new Date().toISOString()
          : null,
    local_time: s.kind === "daily" || s.kind === "weekly" ? s.local_time : null,
    weekdays: s.kind === "weekly" ? s.weekdays.map(String) : [],
    status:
      old?.status === "paused"
        ? "paused"
        : input.draft
          ? "draft"
          : s.kind === "now" || s.kind === "once"
            ? "scheduled"
            : "active",
    next_at:
      input.draft || old?.status === "paused" ? null : preview.data.next_at,
    created_at: old?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    send_on_publish: s.kind === "now",
  };
  messages = [row, ...messages.filter((m) => m.id !== row.id)];
  return { data: row };
}
export async function setNotificationStatus(
  id: string,
  status: "active" | "paused" | "cancelled",
): Promise<NotificationResult<undefined>> {
  messages = messages.map((m) =>
    m.id === id
      ? {
          ...m,
          status,
          next_at:
            status === "active"
              ? previewScheduleInstant(
                  m.send_on_publish
                    ? { kind: "now" }
                    : m.schedule_kind === "daily"
                      ? { kind: "daily", local_time: m.local_time!.slice(0, 5) }
                      : m.schedule_kind === "weekly"
                        ? {
                            kind: "weekly",
                            local_time: m.local_time!.slice(0, 5),
                            weekdays: m.weekdays.map(Number),
                          }
                        : {
                            kind: "once",
                            scheduled_local: formatInTimeZone(
                              m.scheduled_at!,
                              "America/Chicago",
                              "yyyy-MM-dd'T'HH:mm",
                            ),
                          },
                )
              : null,
        }
      : m,
  );
  window.dispatchEvent(
    new CustomEvent("fixture-notification-status", { detail: { id, status } }),
  );
  return { data: undefined };
}
export async function getNotificationPage(
  query: NotificationQuery,
): Promise<
  NotificationResult<NotificationPage<InboxNotification | NotificationMessage>>
> {
  if (scenario === "unavailable")
    return { error: "Notifications are unavailable. Please retry." };
  const rows =
    query.kind === "inbox"
      ? notices
      : messages.filter(
          (m) =>
            (!query.workspace_id || m.workspace_id === query.workspace_id) &&
            (!query.status ||
              query.status === "all" ||
              m.status === query.status),
        );
  const start = query.cursor
    ? rows.findIndex((r) => r.id === query.cursor?.id) + 1
    : 0;
  const slice = rows.slice(start, start + 50);
  const last = slice.at(-1);
  return {
    data: {
      rows: slice,
      next_cursor:
        start + 50 < rows.length && last
          ? { id: last.id, created_at: last.created_at }
          : null,
      unread_count: notices.filter((n) => !n.read_at).length,
    },
  };
}
export async function getNotificationById(
  id: string,
): Promise<NotificationResult<InboxNotification>> {
  const row = notices.find((n) => n.id === id);
  return row ? { data: { ...row } } : { error: "Notification not found" };
}
window.addEventListener("fixture-notification-resolve", (event) => {
  const id = (event as CustomEvent<string>).detail;
  const index = notices.findIndex((row) => row.id === id);
  if (index >= 0)
    notices[index] = {
      ...notices[index],
      read_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
    };
});
export async function getNotificationUnreadCount(): Promise<
  NotificationResult<number>
> {
  return scenario === "unavailable"
    ? { error: "Notifications are unavailable. Please retry." }
    : { data: notices.filter((n) => !n.read_at).length };
}
export async function markNotificationRead(
  id: string,
  read: boolean,
): Promise<NotificationResult<undefined>> {
  const row = notices.find((n) => n.id === id);
  if (row) row.read_at = read ? new Date().toISOString() : null;
  return { data: undefined };
}
export async function getNotificationDeviceEnabled(
  _endpoint: string,
): Promise<NotificationResult<boolean>> {
  void _endpoint;
  return { data: scenario === "device-enabled" };
}
export async function saveNotificationDevice(
  _subscription: PushSubscriptionInput,
): Promise<NotificationResult<string>> {
  void _subscription;
  return { data: "device" };
}
export async function deleteNotificationDevice(
  _endpoint: string,
): Promise<NotificationResult<undefined>> {
  void _endpoint;
  return { data: undefined };
}
