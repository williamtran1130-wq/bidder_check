"use server";
import { z } from "zod";
import { getContext } from "@/lib/auth";
import type { Database } from "@/lib/database.types";
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

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("now") }),
  z.object({
    kind: z.literal("once"),
    scheduled_local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  }),
  z.object({ kind: z.literal("daily"), local_time: time }),
  z.object({
    kind: z.literal("weekly"),
    local_time: time,
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  }),
]);
const validationMessages = new Set([
  "Access denied",
  "Notification not found",
  "Choose a future send time or Send now",
  "Choose a valid Central Time send date",
  "Choose a valid delivery schedule",
  "Choose a valid Central time",
  "Choose at least one valid weekday",
  "This Central Time does not exist because clocks move forward. Choose another time",
  "Title and message are required",
  "Choose valid recipients and schedule",
  "Every selected bidder must be active in this workspace",
  "Choose a send time",
  "Choose at least one weekday",
  "Choose valid weekdays",
  "Only a draft or active schedule can be edited",
  "Only new messages and drafts can be saved as drafts",
  "Invalid message status",
  "Invalid push subscription",
]);
async function perform<T>(
  run: () => Promise<T>,
): Promise<NotificationResult<T>> {
  try {
    return { data: await run() };
  } catch (error) {
    return {
      error:
        error instanceof z.ZodError
          ? "Check the recipients, message and delivery fields."
          : error instanceof Error && validationMessages.has(error.message)
            ? error.message
            : "Notifications are unavailable. Please retry.",
    };
  }
}
async function rpc<N extends keyof Database["public"]["Functions"]>(
  name: N,
  args: Database["public"]["Functions"][N]["Args"],
) {
  const { supabase } = await getContext();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}
export async function previewNotificationSchedule(
  schedule: NotificationSchedule,
): Promise<NotificationResult<NotificationPreview>> {
  return perform(
    async () =>
      (await rpc("preview_notification_schedule", {
        p_schedule: scheduleSchema.parse(schedule),
      })) as NotificationPreview,
  );
}
export async function saveNotificationMessage(
  input: SaveNotificationInput,
): Promise<NotificationResult<NotificationMessage>> {
  return perform(async () => {
    const parsed = z
      .object({
        id: z.uuid().optional(),
        workspace_id: z.uuid(),
        title: z.string().trim().min(1).max(120),
        body: z.string().trim().min(1).max(4000),
        recipient_mode: z.enum(["all", "selected"]),
        recipient_ids: z.array(z.uuid()).max(500),
        schedule: scheduleSchema,
        draft: z.boolean().optional(),
      })
      .parse(input);
    return (await rpc("save_notification_message", {
      p_input: parsed,
    })) as NotificationMessage;
  });
}
export async function setNotificationStatus(
  id: string,
  status: "active" | "paused" | "cancelled",
): Promise<NotificationResult<undefined>> {
  return perform(async () => {
    await rpc("set_message_status", {
      p_id: z.uuid().parse(id),
      p_status: z.enum(["active", "paused", "cancelled"]).parse(status),
    });
    return undefined;
  });
}
export async function getNotificationPage(
  query: NotificationQuery,
): Promise<
  NotificationResult<NotificationPage<InboxNotification | NotificationMessage>>
> {
  return perform(
    async () =>
      (await rpc("notification_page", {
        p_kind: z.enum(["inbox", "messages"]).parse(query.kind),
        p_workspace: query.workspace_id
          ? z.uuid().parse(query.workspace_id)
          : null,
        p_status: query.status ?? null,
        p_cursor: query.cursor
          ? z
              .object({
                created_at: z.iso.datetime({ offset: true }),
                id: z.uuid(),
              })
              .parse(query.cursor)
          : null,
      })) as NotificationPage<InboxNotification | NotificationMessage>,
  );
}
export async function getNotificationById(
  id: string,
): Promise<NotificationResult<InboxNotification>> {
  return perform(
    async () =>
      (await rpc("notification_by_id", {
        p_id: z.uuid().parse(id),
      })) as InboxNotification,
  );
}
export async function getNotificationUnreadCount(): Promise<
  NotificationResult<number>
> {
  return perform(async () =>
    Number(await rpc("notification_unread_count", {})),
  );
}
export async function markNotificationRead(
  id: string,
  read: boolean,
): Promise<NotificationResult<undefined>> {
  return perform(async () => {
    await rpc("mark_notification_read", {
      p_id: z.uuid().parse(id),
      p_read: z.boolean().parse(read),
    });
    return undefined;
  });
}
export async function getNotificationDeviceEnabled(
  endpoint: string,
): Promise<NotificationResult<boolean>> {
  return perform(
    async () =>
      (await rpc("notification_device_enabled", {
        p_endpoint: z.url().parse(endpoint),
      })) as boolean,
  );
}
export async function saveNotificationDevice(
  subscription: PushSubscriptionInput,
): Promise<NotificationResult<string>> {
  return perform(
    async () =>
      (await rpc("save_push_subscription", {
        p_endpoint: z.url().max(2048).parse(subscription.endpoint),
        p_p256dh: z.string().min(1).max(256).parse(subscription.keys?.p256dh),
        p_auth: z.string().min(1).max(256).parse(subscription.keys?.auth),
      })) as string,
  );
}
export async function deleteNotificationDevice(
  endpoint: string,
): Promise<NotificationResult<undefined>> {
  return perform(async () => {
    await rpc("delete_push_subscription", {
      p_endpoint: z.url().parse(endpoint),
    });
    return undefined;
  });
}
