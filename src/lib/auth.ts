import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "./server";
import type { Row } from "./database.types";
import { AuthorizationError } from "./authorization-error";
import { assertLiveSession } from "./live-session";
export { AuthorizationError } from "./authorization-error";
/** React cache is request-local. Every new request confirms the live Auth user. */
export const getActor = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError && !([400, 401, 403].includes(authError.status ?? 0) && authError.name !== "AuthRetryableFetchError") && authError.name !== "AuthSessionMissingError")
    throw new Error("Authentication is temporarily unavailable. Please retry.");
  if (!user) throw new AuthorizationError("/auth/login");
  await assertLiveSession(supabase);
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id,role,approval_status,archived")
    .eq("id", user.id)
    .single();
  if (error?.code === "PT401") throw new AuthorizationError("/auth/login");
  if (error || !profile)
    throw new Error(
      "Your workspace is not ready. The database migration must be installed before using the application.",
    );
  if (profile.archived) throw new AuthorizationError("/auth/inactive");
  if (profile.role === "client" && profile.approval_status !== "approved")
    throw new AuthorizationError("/auth/approval");
  if (profile.role === "bidder") {
    // Workspace RLS includes membership and disabled-parent checks.
    const available = await supabase.from("workspaces").select("id").limit(1);
    if (available.error) throw new Error(available.error.message);
    if (!available.data?.length) throw new AuthorizationError("/auth/inactive");
  }
  return { supabase, user, profile };
});
type Actor = Awaited<ReturnType<typeof getActor>>;
type Context = Omit<Actor, "profile"> & {
  profile: Row<"profiles">;
  workspaces: Row<"workspaces">[];
  selectableWorkspaces: Row<"workspaces">[];
};
async function context(options: { actorOnly: true }): Promise<Actor>;
async function context(options?: { actorOnly?: false }): Promise<Context>;
async function context(options?: {
  actorOnly?: boolean;
}): Promise<Actor | Context> {
  let actor: Actor;
  try {
    actor = await getActor();
  } catch (error) {
    if (error instanceof AuthorizationError) redirect(error.destination);
    throw error;
  }
  if (options?.actorOnly) return actor;
  const [profileResult, workspaceResult] = await Promise.all([
    actor.supabase
      .from("profiles")
      .select("*")
      .eq("id", actor.user.id)
      .single(),
    actor.supabase.from("workspaces")
      .select("*,owner:profiles!workspaces_owner_id_fkey(archived)")
      .order("created_at")
      .overrideTypes<(Row<"workspaces"> & { owner: { archived: boolean } | null })[], { merge: false }>(),
  ]);
  if (profileResult.error || !profileResult.data)
    throw new Error(
      "Your workspace is not ready. The database migration must be installed before using the application.",
    );
  if (workspaceResult.error) throw new Error(workspaceResult.error.message);
  const workspaceRows = workspaceResult.data ?? [];
  const withoutOwner = ({ owner, ...workspace }: (typeof workspaceRows)[number]) => { void owner; return workspace; };
  return {
    ...actor,
    profile: profileResult.data,
    workspaces: workspaceRows.map(withoutOwner),
    selectableWorkspaces: workspaceRows.filter(workspace => !workspace.owner?.archived).map(withoutOwner),
  };
}
export const getContext = cache(context);
