import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { unstable_rethrow } from "next/navigation";
import { getContext } from "./auth";
import { adminClient } from "./admin";
import { actionErrorMessage } from "./action-errors";
import { moneyToCents } from "./domain";
import { executeAccountOperation } from "./account-operation-runner";
import type {
  AccountActionResult,
  AccountKind,
  AccountOperation,
} from "./account-operation-types";
type RPCClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{
    data: unknown;
    error: { code?: string; message: string } | null;
  }>;
};
async function invoke(
  client: unknown,
  name: string,
  args: Record<string, unknown> = {},
) {
  const { data, error } = await (client as RPCClient).rpc(name, args);
  if (error) throw error;
  return data;
}
function safeError(error: unknown) {
  if ((error as { code?: string })?.code === "PBA01")
    return "Resolve the pending account operation first. Open account recovery to continue it.";
  return actionErrorMessage(
    error,
    "Account completion could not be confirmed. Use the saved request to check or resume.",
  );
}
const kinds = z.enum([
  "create_client",
  "create_bidder",
  "update_client",
  "update_bidder",
  "reset_password",
]);
function intent(kind: AccountKind, form: FormData) {
  const text = (key: string) => String(form.get(key) ?? "").trim();
  if (kind === "reset_password")
    return { target: z.uuid().parse(text("user_id")) };
  const name = z.string().min(1).parse(text("display_name"));
  if (kind === "create_client") z.string().max(100).parse(name);
  const email = text("email");
  if (email || kind.startsWith("create_")) z.email().parse(email);
  return {
    name,
    email: email.toLowerCase() || null,
    ...(kind.startsWith("update_")
      ? {
          target: z.uuid().parse(text("user_id")),
          archived: text("archived") === "true",
        }
      : {}),
    ...(kind === "create_bidder"
      ? { workspace: z.uuid().parse(text("workspace_id")) }
      : {}),
    ...(kind.endsWith("bidder") ? { rate: moneyToCents(text("rate")) } : {}),
  };
}
async function drive(
  request: string,
  context: Awaited<ReturnType<typeof getContext>>,
) {
  const service = adminClient(true);
  return executeAccountOperation(request, context.profile.id, {
    rpc: (name, args) =>
      invoke(
        name === "dispatch_account_operation" ? service : context.supabase,
        name,
        args,
      ),
    auth: service.auth.admin,
  });
}
export async function submitAccountOperation(
  kind: AccountKind,
  form: FormData,
  requestId?: string,
): Promise<AccountActionResult> {
  let operation: AccountOperation | undefined;
  let request: string | undefined;
  let began = false;
  let context: Awaited<ReturnType<typeof getContext>> | undefined;
  try {
    request = z
      .uuid()
      .parse(requestId ?? String(form.get("request_id") || randomUUID()));
    kinds.parse(kind);
    const payload = intent(kind, form);
    context = await getContext();
    adminClient(true);
    began = true;
    operation = (await invoke(context.supabase, "begin_account_operation", {
      p_request: request,
      p_kind: kind,
      p_payload: payload,
    })) as AccountOperation;
    await invoke(context.supabase, "reconcile_account_operation", {
      p_request: request,
    });
    return await drive(request, context);
  } catch (error) {
    unstable_rethrow(error);
    let notStarted = !operation && !began;
    // SQL rejection alone does not distinguish a new invalid intent from a
    // fingerprint conflict on an existing request. Only an actor-scoped probe
    // under the begin lock may release the frozen identity after rejection.
    // Transport-uncertain begins are never released based on a later absence.
    const definite = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(
      (error as { code?: string })?.code ?? "",
    );
    if (!operation && began && definite && context && request) {
      try {
        notStarted =
          (await invoke(context.supabase, "account_operation_request_exists", {
            p_request: request,
          })) === false;
      } catch (probeError) {
        unstable_rethrow(probeError);
        // A failed probe cannot prove that discarding the saved request is safe.
      }
    }
    return {
      error: safeError(error),
      requestId: request,
      notStarted,
      ...(operation ? { operation } : {}),
    };
  }
}
export async function resumeAccountOperation(
  request: string,
): Promise<AccountActionResult> {
  let operation: AccountOperation | undefined;
  try {
    z.uuid().parse(request);
    const context = await getContext();
    operation = (await invoke(context.supabase, "reconcile_account_operation", {
      p_request: request,
    })) as AccountOperation;
    return await drive(request, context);
  } catch (error) {
    unstable_rethrow(error);
    return { error: safeError(error), ...(operation ? { operation } : {}) };
  }
}
export async function accountRecoveryList() {
  try {
    const context = await getContext();
    const operations = (await invoke(
      context.supabase,
      "list_account_operations",
    )) as AccountOperation[];
    return {
      data: {
        actorId: context.profile.id,
        admin: context.profile.role === "admin",
        operations,
      },
    };
  } catch (error) {
    unstable_rethrow(error);
    return { error: safeError(error) };
  }
}
export async function abandonAccountOperation(
  request: string,
): Promise<AccountActionResult> {
  try {
    const { supabase } = await getContext();
    const operation = (await invoke(supabase, "abandon_account_operation", {
      p_request: z.uuid().parse(request),
    })) as AccountOperation;
    return { data: undefined, operation };
  } catch (error) {
    unstable_rethrow(error);
    return { error: safeError(error) };
  }
}
