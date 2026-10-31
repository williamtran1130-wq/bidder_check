import type { Row } from "./database.types";
export type WorkspaceMembership = Pick<Row<"workspaces">, "id" | "owner_id">;
export function workspaceActorScope(
  profile: Pick<
    Row<"profiles">,
    "id" | "role" | "approval_status" | "archived"
  >,
  workspaces: WorkspaceMembership[],
) {
  return `actor:${JSON.stringify([
    profile.id,
    profile.role,
    profile.approval_status,
    profile.archived,
    workspaces
      .map((workspace) => [workspace.id, workspace.owner_id])
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
  ])}:`;
}
