import "server-only";
import { z } from "zod";
import { unstable_rethrow } from "next/navigation";
import { getContext } from "@/lib/auth";
import type { Database } from "@/lib/database.types";
import type {
  InboxNotification,
  NotificationMessage,
  NotificationPage,
  NotificationQuery,
  NotificationResult,
} from "@/lib/notification-types";

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
    unstable_rethrow(error);
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
  const { supabase } = await getContext({ actorOnly: true });
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
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
        p_status:
          query.status === undefined ? null : z.string().parse(query.status),
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
