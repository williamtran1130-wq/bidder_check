import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { executeAccountOperation } from "@/lib/account-operation-runner";
const request = "22000000-0000-4000-8000-000000000010";
function fixture(
  loss: "none" | "auth-response" | "before-auth" | "finish-response" = "none",
  authStep = "ready",
) {
  const journal = {
    requestId: request,
    actorId: "actor",
    targetId: "target",
    kind: "reset_password",
    payload: { target: "target" },
    status: "ready",
    authStep,
  } as Record<string, unknown>;
  let resets = 0,
    audits = 0;
  const rpc = async (name: string) => {
    if (name === "dispatch_account_operation" && journal.authStep === "ready") {
      journal.authStep = "dispatched";
      journal.status = "pending";
      return { ...journal, dispatchId: "dispatch" };
    }
    if (
      name === "finish_account_operation" &&
      ["accepted", "skipped"].includes(journal.authStep as string) &&
      journal.status !== "completed"
    ) {
      journal.status = "completed";
      audits++;
      if (loss === "finish-response") throw new Error("SQL response lost");
    }
    return { ...journal };
  };
  const auth = {
    updateUserById: async (
      _target: string,
      attributes: Record<string, unknown>,
    ) => {
      if (loss === "before-auth") throw new Error("request lost");
      expect(attributes).toMatchObject({
        password: "123456",
        app_metadata: {
          managed_account_operation: { request, dispatch: "dispatch" },
        },
      });
      resets++;
      journal.authStep = "accepted";
      if (loss === "auth-response") throw new Error("response lost");
      return { error: null };
    },
    createUser: async () => {
      throw new Error("wrong Auth effect");
    },
  };
  return { rpc, auth, journal, counts: () => ({ resets, audits }) };
}
it.each(["none", "auth-response", "finish-response"] as const)(
  "reconciles %s without repeating an accepted password reset",
  async (loss) => {
    const f = fixture(loss);
    const result = await executeAccountOperation(request, "actor", f);
    expect(result.operation?.status).toBe("completed");
    await executeAccountOperation(request, "actor", f);
    expect(f.counts()).toEqual({ resets: 1, audits: 1 });
  },
);
it("reports pending when dispatch has no receipt; replay cannot blindly repeat password reset", async () => {
  const f = fixture("before-auth");
  const result = await executeAccountOperation(request, "actor", f);
  expect(result.error).toBeTruthy();
  expect(result.operation?.status).toBe("pending");
  await executeAccountOperation(request, "actor", f);
  expect(f.counts()).toEqual({ resets: 0, audits: 0 });
});
it("skips Auth for an unchanged email and returns success only after SQL completion", async () => {
  const f = fixture("none", "skipped");
  expect(
    (await executeAccountOperation(request, "actor", f)).operation?.status,
  ).toBe("completed");
  expect(f.counts()).toEqual({ resets: 0, audits: 1 });
});
it("requires password re-entry before dispatching an unaccepted custom password operation", async () => {
  const f = fixture(); f.journal.kind = "set_bidder_password";
  const result = await executeAccountOperation(request, "actor", f);
  expect(result.requiresPassword).toBe(true);
  expect(f.journal.authStep).toBe("ready");
  expect(f.counts()).toEqual({ resets: 0, audits: 0 });
});
it("sends only ephemeral custom credentials to Auth and their commitment to dispatch", async () => {
  const f = fixture(); f.journal.kind = "set_bidder_password";
  const effects: Record<string, unknown>[] = [];
  const deps = { ...f, rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "dispatch_account_operation") expect(args.p_password_commitment).toBe("commitment");
    return f.rpc(name);
  }, auth: { ...f.auth, updateUserById: async (_id: string, value: Record<string, unknown>) => {
    effects.push(value); f.journal.authStep = "accepted"; return { error: null };
  } } };
  const result = await executeAccountOperation(request, "actor", deps, { password: "  new password  ", commitment: "commitment" });
  expect(effects).toEqual([{ password: "  new password  ", app_metadata: { managed_account_operation: { request, dispatch: "dispatch" } } }]);
  expect(result.operation?.status).toBe("completed");
  expect(JSON.stringify(result)).not.toContain("new password");
  await executeAccountOperation(request, "actor", deps);
  expect(effects).toHaveLength(1);
});
