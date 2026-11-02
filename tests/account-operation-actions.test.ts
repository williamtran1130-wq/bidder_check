import { beforeEach, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  adminRpc: vi.fn(),
  contextError: undefined as unknown,
  auth: { createUser: vi.fn(), updateUserById: vi.fn() },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  getContext: async () => {
    if (state.contextError) throw state.contextError;
    return {
      profile: { id: "22000000-0000-4000-8000-000000000001", role: "admin" },
      supabase: { rpc: state.rpc },
    };
  },
}));
vi.mock("@/lib/admin", () => ({
  adminClient: () => ({ rpc: state.adminRpc, auth: { admin: state.auth } }),
}));
import {
  submitAccountOperation,
  resumeAccountOperation,
  submitBidderPassword,
} from "@/lib/account-operation-server";
const request = "22000000-0000-4000-8000-000000000010";
const target = "22000000-0000-4000-8000-000000000002";
const form = () => {
  const f = new FormData();
  f.set("user_id", target);
  f.set("display_name", "  Long name  ");
  f.set("email", " OWNER@EXAMPLE.TEST ");
  f.set("archived", "false");
  return f;
};
beforeEach(() => {
  state.contextError = undefined;
  state.rpc.mockReset();
  state.adminRpc.mockReset();
  state.auth.createUser.mockReset();
  state.auth.updateUserById.mockReset();
});
it("rejects invalid passwords before creating a recovery record", async () => {
  for (const [password, confirmation] of [["short", "short"], ["a".repeat(129), "a".repeat(129)], ["valid password", "different"]]) {
    const result = await submitBidderPassword(request, target, password, confirmation);
    expect(result).toMatchObject({ requiresPassword: true, error: expect.any(String) });
    expect(result.notStarted).not.toBe(true);
  }
  expect(state.rpc).not.toHaveBeenCalled();
});
it("offers password re-entry when a saved request never reached begin without discarding its identity", async () => {
  state.rpc.mockImplementation(async name => name === "account_operation_request_exists"
    ? { data: false, error: null }
    : { data: null, error: { code: "P0001", message: "Access denied" } });
  const result = await resumeAccountOperation(request, true);
  expect(result.requiresPassword).toBe(true);
  expect(result.notStarted).not.toBe(true);
});
it("journals a server commitment without the password or confirmation", async () => {
  vi.stubEnv("MANAGED_PASSWORD_HMAC_KEY", "a".repeat(64));
  const password = "  chosen password  ";
  const op = { requestId: request, actorId: target, targetId: target, kind: "set_bidder_password", payload: { target }, status: "completed", authStep: "accepted" };
  state.rpc.mockImplementation(async (name, args) => {
    if (name === "begin_account_operation") {
      expect(args.p_payload).toEqual({ target, password_commitment: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(JSON.stringify(args)).not.toContain(password);
    }
    return { data: op, error: null };
  });
  try { expect((await submitBidderPassword(request, target, password, password)).operation?.status).toBe("completed"); }
  finally { vi.unstubAllEnvs(); }
});
it("keeps a request recoverable when begin committed but its response was lost", async () => {
  state.rpc.mockRejectedValue(new Error("transport lost"));
  const result = await submitAccountOperation("update_client", form(), request);
  expect(result).toMatchObject({
    requestId: request,
    notStarted: false,
    error: expect.any(String),
  });
  expect(state.auth.updateUserById).not.toHaveBeenCalled();
});
it("never releases a frozen request on a same-ID different-content rejection", async () => {
  state.rpc.mockResolvedValue({
    error: {
      code: "P0001",
      message: "This request ID was already used with different content",
    },
  });
  const result = await submitAccountOperation("update_client", form(), request);
  expect(result.notStarted).toBe(false);
});
it("normalizes intended values before journaling and skips Auth when the database reports unchanged email", async () => {
  const op = {
    requestId: request,
    actorId: target,
    targetId: target,
    kind: "update_client",
    payload: {},
    status: "ready",
    authStep: "skipped",
  };
  state.rpc.mockImplementation(async (name, args) => {
    if (name === "begin_account_operation")
      expect(args.p_payload).toEqual({
        target,
        name: "Long name",
        email: "owner@example.test",
        archived: false,
      });
    return {
      data: {
        ...op,
        status: name === "finish_account_operation" ? "completed" : "ready",
      },
      error: null,
    };
  });
  state.adminRpc.mockResolvedValue({ data: op, error: null });
  expect(
    (await submitAccountOperation("update_client", form(), request)).operation
      ?.status,
  ).toBe("completed");
  expect(state.auth.updateUserById).not.toHaveBeenCalled();
});
it("allows correcting invalid unstarted fields without storing provider details or dispatching", async () => {
  const invalid = form();
  invalid.set("email", "invalid");
  const result = await submitAccountOperation(
    "update_client",
    invalid,
    request,
  );
  expect(result.notStarted).toBe(true);
  expect(state.rpc).not.toHaveBeenCalled();
  expect(result.error).not.toContain("invalid_format");
});
it("rethrows framework redirects through new submission and recovery boundaries", async () => {
  try {
    redirect("/login");
  } catch (error) {
    state.contextError = error;
  }
  await expect(
    submitAccountOperation("update_client", form(), request),
  ).rejects.toBe(state.contextError);
  await expect(resumeAccountOperation(request)).rejects.toBe(
    state.contextError,
  );
});
it("releases a rejected new intent only after an authenticated probe confirms no request exists", async () => {
  state.rpc.mockImplementation(async (name) =>
    name === "account_operation_request_exists"
      ? { data: false, error: null }
      : {
          error: {
            code: "P0001",
            message: "This email is already in use or reserved",
          },
        },
  );
  const result = await submitAccountOperation("create_client", form(), request);
  expect(result).toMatchObject({
    notStarted: true,
    error: "This email is already in use or reserved",
  });
  expect(state.auth.createUser).not.toHaveBeenCalled();
});
it("keeps an existing request frozen after a definite rejection and a positive actor-scoped probe", async () => {
  state.rpc.mockImplementation(async (name) =>
    name === "account_operation_request_exists"
      ? { data: true, error: null }
      : {
          error: {
            code: "P0001",
            message: "This request ID was already used with different content",
          },
        },
  );
  expect(
    (await submitAccountOperation("create_client", form(), request)).notStarted,
  ).toBe(false);
});
it("does not clear uncertain requests even if a later absence probe could return false", async () => {
  state.rpc.mockImplementation(async (name) => {
    if (name === "account_operation_request_exists")
      return { data: false, error: null };
    throw new Error("response lost");
  });
  expect(
    (await submitAccountOperation("create_client", form(), request)).notStarted,
  ).toBe(false);
  expect(state.rpc).toHaveBeenCalledTimes(1);
});
it("keeps a rejected request frozen if its confirming database probe fails", async () => {
  state.rpc.mockImplementation(async (name) => {
    if (name === "account_operation_request_exists")
      throw new Error("probe unavailable");
    return {
      error: {
        code: "P0001",
        message: "This email is already in use or reserved",
      },
    };
  });
  const result = await submitAccountOperation("create_client", form(), request);
  expect(result.notStarted).toBe(false);
  expect(result.error).toBe("This email is already in use or reserved");
});
