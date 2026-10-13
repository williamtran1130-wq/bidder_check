import type { Row } from "./database.types";
export type NotificationSchedule =
  | { kind: "now" }
  | { kind: "once"; scheduled_local: string }
  | { kind: "daily"; local_time: string }
  | { kind: "weekly"; local_time: string; weekdays: number[] };
export type NotificationResult<T> = { data?: T; error?: string };
export type NotificationCursor = { created_at: string; id: string };
export type InboxNotification = Row<"inbox_notifications">;
export type NotificationMessage = Row<"client_messages"> & {
  latest_publication?: { published_at: string; recipient_count: number } | null;
};
export type NotificationPage<T> = {
  rows: T[];
  next_cursor: NotificationCursor | null;
  unread_count: number;
};
export type NotificationQuery = {
  kind: "inbox" | "messages";
  workspace_id?: string;
  status?: string;
  cursor?: NotificationCursor | null;
};
export type SaveNotificationInput = {
  id?: string;
  workspace_id: string;
  title: string;
  body: string;
  recipient_mode: "all" | "selected";
  recipient_ids: string[];
  schedule: NotificationSchedule;
  draft?: boolean;
};
export type NotificationPreview = {
  next_at: string;
  timezone: "America/Chicago";
};
export type PushSubscriptionInput = {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string };
};
