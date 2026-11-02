import "server-only";
import { unstable_rethrow } from "next/navigation";
import type {
  AccountActionResult,
  AccountOperation,
} from "./account-operation-types";
type Dependencies = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  auth: {
    createUser: (
      attributes: Record<string, unknown>,
    ) => Promise<{ error: unknown }>;
    updateUserById: (
      id: string,
      attributes: Record<string, unknown>,
    ) => Promise<{ error: unknown }>;
  };
};
export type EphemeralPassword = { password: string; commitment: string };
const pending = (operation: AccountOperation): AccountActionResult => ({
  error:
    operation.authStep === "accepted"
      ? "The sign-in change is confirmed. Account details or audit completion are pending. Resume this request."
      : operation.authStep === "skipped"
        ? "Account details or audit completion are pending. Resume this request."
        : "Account completion is pending. Wait up to a minute, then check this request before making another change.",
  operation,
});
function result(operation: AccountOperation): AccountActionResult {
  if (operation.status === "completed") return { data: undefined, operation };
  if (operation.status === "abandoned")
    return {
      error:
        operation.disposition ??
        "This request was abandoned. Review the account before starting another change.",
      operation,
    };
  return pending(operation);
}
/** Never retries an Auth call. SQL's fenced dispatch and transactional receipt own replay. */
export async function executeAccountOperation(
  request: string,
  actor: string,
  deps: Dependencies,
  credentials?: EphemeralPassword,
): Promise<AccountActionResult> {
  let operation = (await deps.rpc("account_operation_status", {
    p_request: request,
  })) as AccountOperation;
  if (operation.status === "completed" || operation.status === "abandoned")
    return result(operation);
  if (
    operation.kind === "set_bidder_password" &&
    operation.authStep === "ready" &&
    !credentials
  )
    return {
      operation,
      requiresPassword: true,
      error: "Re-enter the original password to resume this request.",
    };
  operation = (await deps.rpc("dispatch_account_operation", {
    p_request: request,
    p_actor: actor,
    ...(credentials ? { p_password_commitment: credentials.commitment } : {}),
  })) as AccountOperation;
  if (operation.dispatchId) {
    const app_metadata = {
      managed_account_operation: { request, dispatch: operation.dispatchId },
    };
    try {
      if (
        operation.kind === "create_client" ||
        operation.kind === "create_bidder"
      ) {
        await deps.auth.createUser({
          id: operation.targetId,
          email: operation.payload.email!,
          password: "123456",
          email_confirm: true,
          user_metadata: { display_name: operation.payload.name! },
          app_metadata,
        });
      } else {
        await deps.auth.updateUserById(
          operation.targetId,
          operation.kind === "set_bidder_password"
            ? { password: credentials!.password, app_metadata }
            : operation.kind === "reset_password"
              ? { password: "123456", app_metadata }
              : {
                  email: operation.payload.email!,
                  email_confirm: true,
                  app_metadata,
                },
        );
      }
    } catch (error) {
      unstable_rethrow(error);
      // A lost response cannot tell us whether Auth committed. Its transaction
      // writes the receipt, which finish/status inspect without another effect.
    }
  }
  try {
    operation = (await deps.rpc("finish_account_operation", {
      p_request: request,
    })) as AccountOperation;
  } catch (error) {
    unstable_rethrow(error);
    try {
      operation = (await deps.rpc("account_operation_status", {
        p_request: request,
      })) as AccountOperation;
    } catch (readError) {
      unstable_rethrow(readError);
      return pending(operation);
    }
  }
  return result(operation);
}
