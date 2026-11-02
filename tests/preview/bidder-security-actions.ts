import type {
  AccountActionResult,
  AccountKind,
  AccountOperation,
} from "@/lib/account-operation-types";
import { fixture } from "./sample-data";
const key = "fixture-bidder-security";
type State = { operation: AccountOperation; effects: number };
const read = (): State | null =>
  JSON.parse(sessionStorage.getItem(key) || "null");
export async function list() {
  const state = read();
  return {
    data: {
      actorId: fixture.profile.id,
      admin: false,
      operations:
        state && state.operation.status !== "completed"
          ? [state.operation]
          : [],
    },
  };
}
export async function submit(
  request: string,
  kind: AccountKind,
  fields: Record<string, string>,
  password?: string,
  confirmation?: string,
): Promise<AccountActionResult> {
  let state = read();
  if (kind === "set_bidder_password" && !password) return resume(request);
  if (
    kind === "set_bidder_password" &&
    (password!.length < 8 || password !== confirmation)
  )
    return { error: "Passwords must match.", notStarted: true };
  if (!state) {
    state = {
      operation: {
        requestId: request,
        actorId: fixture.profile.id,
        targetId: fields.user_id,
        kind,
        payload: { target: fields.user_id },
        status: "ready",
        authStep: kind === "sign_out_bidder" ? "skipped" : "ready",
      },
      effects: 0,
    };
    sessionStorage.setItem(key, JSON.stringify(state));
    if (
      new URLSearchParams(location.search).get("bidder-security") === "recover"
    )
      throw new Error("Lost response before Auth");
  }
  if (state.operation.requestId !== request)
    return { error: "Request identity changed" };
  if (state.operation.status !== "completed") {
    state.effects++;
    state.operation.status = "completed";
    state.operation.authStep =
      kind === "set_bidder_password" ? "accepted" : "skipped";
  }
  sessionStorage.setItem(key, JSON.stringify(state));
  return { operation: state.operation };
}
export async function resume(request: string): Promise<AccountActionResult> {
  const state = read();
  if (!state || state.operation.requestId !== request)
    return { error: "Missing request" };
  if (
    state.operation.kind === "set_bidder_password" &&
    state.operation.status !== "completed"
  )
    return {
      operation: state.operation,
      requiresPassword: true,
      error: "Re-enter the original password to resume this request.",
    };
  return { operation: state.operation };
}
