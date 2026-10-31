import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notFound, redirect, unstable_rethrow } from "next/navigation";

type ActorState =
  | "active"
  | "bidder"
  | "signed-out"
  | "archived"
  | "pending"
  | "disabled-parent"
  | "profile-error";
const state = vi.hoisted(() => ({
  actor: "active" as ActorState,
  authGate: undefined as Promise<void> | undefined,
  profileGate: undefined as Promise<void> | undefined,
  authCalls: 0,
  protectedReads: [] as string[],
  rpc: vi.fn(),
  authError: undefined as unknown,
}));
vi.mock("server-only", () => ({}));
// The only application dependency replaced is the Supabase server boundary.
// Actual React cache, Next redirect, auth, services, handler and client run here.
vi.mock("@/lib/server", () => ({
  createClient: async () => {
    let actor = state.actor;
    return {
      auth: {
        getUser: async () => {
          state.authCalls++;
          await state.authGate;
          actor = state.actor;
          if (state.authError) throw state.authError;
          return {
            data: { user: actor === "signed-out" ? null : { id: "actor" } },
          };
        },
      },
      from: (table: string) => {
        if (table !== "profiles" && table !== "workspaces")
          state.protectedReads.push(table);
        const query = {
          select: () => query,
          eq: () => query,
          single: async () => {
            await state.profileGate;
            actor = state.actor;
            return {
              data:
                actor === "profile-error"
                  ? null
                  : {
                      id: "actor",
                      role:
                        actor === "disabled-parent" || actor === "bidder"
                          ? "bidder"
                          : "client",
                      archived: actor === "archived",
                      approval_status:
                        actor === "pending" ? "pending" : "approved",
                    },
              error:
                actor === "profile-error"
                  ? { message: "private database detail" }
                  : null,
            };
          },
          limit: async () => ({
            data: actor === "disabled-parent" ? [] : [{ id: "workspace" }],
            error: null,
          }),
        };
        return query;
      },
      rpc: state.rpc,
    };
  },
}));

import { handleRead } from "@/lib/read-handler";
import * as client from "@/lib/read-client";
import {
  getBidHistory,
  getDashboardPerformance,
} from "@/app/(workspace)/actions";
import { readReport } from "@/lib/reporting-server";


const bidId = "00000000-0000-4000-8000-000000000001";
const revokedCases = [
  ["signed-out", 401, "/auth/login"],
  ["archived", 403, "/auth/inactive"],
  ["pending", 403, "/auth/approval"],
  ["disabled-parent", 403, "/auth/inactive"],
] as const;

function browser() {
  const win = Object.assign(new EventTarget(), {
    location: { assign: vi.fn() },
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  const reset = vi.fn();
  win.addEventListener("workspace-access-revoked", reset);
  return { win, reset };
}
function controlError(run: () => never) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected Next control flow");
}
beforeEach(() => {
  state.actor = "active";
  state.authGate = undefined;
  state.profileGate = undefined;
  state.authCalls = 0;
  state.protectedReads = [];
  state.authError = undefined;
  state.rpc.mockReset().mockResolvedValue({ data: 3, error: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("fresh service-boundary authorization through actual read transport", () => {
  it.each(revokedCases)(
    "POST parsing then %s revocation is checked at the service gate",
    async (actor, status, destination) => {
      const parsing = deferred<void>();
      const parsed = deferred<unknown>();
      const request = new Request("https://local/api/read/purges", {
        method: "POST",
        body: "null",
      });
      vi.spyOn(request, "json").mockImplementation(() => {
        parsing.resolve();
        return parsed.promise;
      });
      const responsePromise = handleRead(request, "purges");
      await parsing.promise;
      expect(state.authCalls).toBe(0);
      state.actor = actor;
      parsed.resolve(null);
      const response = await responsePromise;
      expect(state.authCalls).toBe(1);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ destination });
      expect(state.rpc).not.toHaveBeenCalled();
      expect(state.protectedReads).toEqual([]);
    },
  );

  it("blocks private reads until the live auth gate resolves and checks anew next request", async () => {
    const gate = deferred<void>();
    state.authGate = gate.promise;
    const responsePromise = handleRead(
      new Request("https://local/api/read/purges"),
      "purges",
    );
    await vi.waitFor(() => expect(state.authCalls).toBe(1));
    expect(state.rpc).not.toHaveBeenCalled();
    gate.resolve();
    expect(await (await responsePromise).json()).toEqual({ data: 3 });
    expect(state.authCalls).toBe(1);
    expect(state.rpc).toHaveBeenCalledOnce();
    state.actor = "archived";
    const denied = await handleRead(
      new Request("https://local/api/read/purges"),
      "purges",
    );
    expect(denied.status).toBe(403);
    expect(state.authCalls).toBe(2);
    expect(state.rpc).toHaveBeenCalledOnce();
  });

  it("waits for current profile approval before exposing protected results", async () => {
    const gate = deferred<void>();
    state.profileGate = gate.promise;
    const responsePromise = handleRead(
      new Request("https://local/api/read/purges"),
      "purges",
    );
    await vi.waitFor(() => expect(state.authCalls).toBe(1));
    expect(state.rpc).not.toHaveBeenCalled();
    state.actor = "pending";
    gate.resolve();
    const response = await responsePromise;
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      destination: "/auth/approval",
    });
    expect(state.authCalls).toBe(1);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("keeps the financial report role gate on the same freshly checked bidder", async () => {
    state.actor = "bidder";
    const request = new Request("https://local/api/read/earnings", {
      method: "POST",
      body: JSON.stringify({ period: { preset: "all" }, group: "bidder" }),
    });
    const response = await handleRead(request, "earnings");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
    expect(state.authCalls).toBe(1);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  const earlyResponses = [
    ["unknown", "unknown", null, 404],
    ["malformed JSON", "purges", undefined, 400],
    ["handler schema", "history", 42, 400],
    ["history UUID", "history", "bad", 200],
    ["purge UUID", "purge", "bad", 200],
    [
      "calendar",
      "dashboard",
      { period: { preset: "custom", from: "bad", to: "bad" } },
      200,
    ],
    [
      "report filter",
      "dashboard",
      { period: { preset: "all" }, workspace: "bad" },
      200,
    ],
    [
      "report group",
      "earnings",
      { period: { preset: "all" }, group: "bad" },
      200,
    ],
  ] as const;
  it.each(earlyResponses)(
    "%s response is authorized even when service returns before its context",
    async (_name, operation, input, status) => {
      const request = () =>
        new Request(`https://local/api/read/${operation}`, {
          method: "POST",
          body: input === undefined ? "{" : JSON.stringify(input),
        });
      const allowed = await handleRead(request(), operation);
      expect(allowed.status).toBe(status);
      expect(await allowed.json()).toHaveProperty("error");
      expect(state.authCalls).toBe(1);
      for (const [actor, deniedStatus, destination] of revokedCases) {
        state.actor = actor;
        const before = state.authCalls;
        const denied = await handleRead(request(), operation);
        expect(denied.status).toBe(deniedStatus);
        expect(await denied.json()).toMatchObject({ destination });
        expect(state.authCalls).toBe(before + 1);
        expect(denied.headers.get("Cache-Control")).toBe("private, no-store");
      }
      expect(state.rpc).not.toHaveBeenCalled();
      expect(state.protectedReads).toEqual([]);
    },
  );
  it.each(revokedCases)(
    "unread %s returns private %i and resets/navigates to %s",
    async (actor, status, destination) => {
      state.actor = actor;
      const response = await handleRead(
        new Request("https://local/api/read/purges"),
        "purges",
      );
      expect(state.authCalls).toBe(1);
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Vary")).toBe("Cookie");
      expect(response.headers.get("Location")).toBeNull();
      expect(response.headers.get("Content-Type")).toContain(
        "application/json",
      );
      expect(await response.clone().json()).toMatchObject({ destination });
      expect(state.rpc).not.toHaveBeenCalled();
      expect(state.protectedReads).toEqual([]);

      const { win, reset } = browser();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      await client.recentBidPurges();
      expect(reset).toHaveBeenCalledOnce();
      expect(win.location.assign).toHaveBeenCalledExactlyOnceWith(destination);
    },
  );

  it.each(revokedCases)(
    "report %s preserves the typed failure through the report service",
    async (actor, status, destination) => {
      state.actor = actor;
      const input = encodeURIComponent(
        JSON.stringify({ period: { preset: "all" } }),
      );
      const response = await handleRead(
        new Request(`https://local/api/read/dashboard?q=${input}`),
        "dashboard",
      );
      expect(state.authCalls).toBe(1);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ destination });
      expect(state.rpc).not.toHaveBeenCalled();
    },
  );

  it("history also preserves service-side authorization without querying private history", async () => {
    state.actor = "archived";
    const response = await handleRead(
      new Request(
        `https://local/api/read/history?q=${encodeURIComponent(JSON.stringify(bidId))}`,
      ),
      "history",
    );
    expect(state.authCalls).toBe(1);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      destination: "/auth/inactive",
    });
    expect(state.protectedReads).toEqual([]);
  });

  it.each(["profile-error", "rpc-error"] as const)(
    "%s stays a business failure and retains same-query data without navigation",
    async (failure) => {
      state.actor = failure === "profile-error" ? "profile-error" : "active";
      if (failure === "rpc-error")
        state.rpc.mockResolvedValue({
          data: null,
          error: { message: "private database detail" },
        });
      const response = await handleRead(
        new Request("https://local/api/read/purges"),
        "purges",
      );
      expect(state.authCalls).toBe(1);
      const error =
        failure === "profile-error"
          ? "This request could not be completed. Please retry."
          : "This request could not be completed. Please retry.";
      expect(response.status).toBe(failure === "profile-error" ? 500 : 200);
      expect(await response.clone().json()).toEqual({ error });
      if (failure === "profile-error") expect(state.rpc).not.toHaveBeenCalled();
      const { win, reset } = browser();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      await client.recentBidPurges();
      expect(reset).not.toHaveBeenCalled();
      expect(win.location.assign).not.toHaveBeenCalled();
    },
  );

  it.each(["purges", "unknown", "history"])(
    "preserves unrelated Next control exceptions in %s",
    async (operation) => {
      const expected = controlError(notFound);
      state.authError = expected;
      await expect(
        handleRead(
          new Request(`https://local/api/read/${operation}`),
          operation,
        ),
      ).rejects.toBe(expected);
    },
  );
});

describe("default legacy and RSC authorization behavior", () => {
  for (const [name, run] of [
    ["history action", () => getBidHistory(bidId)],
    [
      "report action",
      () => getDashboardPerformance({ period: { preset: "all" } }),
    ],
    [
      "RSC report seed",
      () =>
        readReport("dashboard_performance_v2", { period: { preset: "all" } }),
    ],
  ] as const) {
    it.each(revokedCases)(
      `${name} %s still redirects to its original destination`,
      async (actor, _status, destination) => {
        state.actor = actor;
        const expected = controlError(() => redirect(destination));
        try {
          await run();
          throw new Error("Expected authorization redirect");
        } catch (error) {
          expect(error).toMatchObject(expected as object);
          expect(() => unstable_rethrow(error)).toThrow(error as Error);
        }
        expect(state.authCalls).toBe(1);
        expect(state.rpc).not.toHaveBeenCalled();
        expect(state.protectedReads).toEqual([]);
      },
    );
  }
});
