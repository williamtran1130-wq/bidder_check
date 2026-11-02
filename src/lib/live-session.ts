import "server-only";
import { AuthorizationError } from "./authorization-error";

type SessionClient = {
  rpc(
    name: "enforce_live_session",
  ): PromiseLike<{ error: { code?: string } | null }>;
};
/** Check the live Auth session, rather than trusting a still-valid access JWT. */
export async function assertLiveSession(client: SessionClient): Promise<void> {
  const { error } = await client.rpc("enforce_live_session");
  if (error?.code === "PT401") throw new AuthorizationError("/auth/login");
  if (error)
    throw new Error(
      "Session verification is temporarily unavailable. Please retry.",
    );
}
