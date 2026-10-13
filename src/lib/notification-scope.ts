import type { Row } from "./database.types";
export type NotificationMembership = Pick<Row<"workspaces">, "id" | "owner_id">;
export function notificationScope(
  profile: Pick<
    Row<"profiles">,
    "id" | "role" | "approval_status" | "archived"
  >,
  workspaces: NotificationMembership[],
) {
  return `notification:${JSON.stringify([
    profile.id,
    profile.role,
    profile.approval_status,
    profile.archived,
    workspaces
      .map((workspace) => [workspace.id, workspace.owner_id])
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
  ])}:`;
}
