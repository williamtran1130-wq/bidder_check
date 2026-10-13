// Deliberately isolated fake provider/journal boundary for the real account UI.
import type {
  AccountKind,
  AccountOperation,
} from "@/lib/account-operation-types";
import { fixture } from "./sample-data";
const key = "fixture-account-journal";
type State = {
  operation: AccountOperation;
  effects: number;
  requests: string[];
};
function read(): State | null {
  return JSON.parse(sessionStorage.getItem(key) || "null");
}
export async function list() {
  const value = read();
  return {
    data: {
      actorId: fixture.profile.id,
      admin: true,
      operations:
        value && value.operation.status !== "completed"
          ? [value.operation]
          : [],
    },
  };
}
export async function submit(
  request: string,
  kind: AccountKind,
  fields: Record<string, string>,
) {
  // Match the server's definite-rejection + negative actor-scoped probe outcome.
  // No provider effect or journal exists for this rejected request.
  if (
    new URLSearchParams(location.search).get("account-recovery") ===
      "duplicate" &&
    fields.email === "existing@example.test"
  ) {
    sessionStorage.setItem("fixture-account-rejected-request", request);
    return {
      error: "This email is already in use or reserved",
      notStarted: true,
    };
  }
  let state = read();
  if (!state) {
    state = {
      operation: {
        requestId: request,
        actorId: fixture.profile.id,
        targetId: "fixture-target",
        kind,
        payload: { email: fields.email, name: fields.display_name },
        status: "pending",
        authStep: "accepted",
      },
      effects: 1,
      requests: [request],
    };
    sessionStorage.setItem(key, JSON.stringify(state));
    if (new URLSearchParams(location.search).get("account-recovery") === "lost")
      throw new Error("provider response lost");
    return {
      error:
        "The sign-in change is confirmed. Account details or audit completion are pending. Resume this request.",
      operation: state.operation,
    };
  }
  state.requests.push(request);
  if (request !== state.operation.requestId)
    throw new Error("request identity changed");
  state.operation.status = "completed";
  sessionStorage.setItem(key, JSON.stringify(state));
  return { data: undefined, operation: state.operation };
}
export async function resume(request: string) {
  const state = read();
  if (!state) return { error: "Missing fixture request" };
  return submit(request, state.operation.kind, {});
}
export async function abandon() {
  return { error: "Not used by this fixture" };
}
