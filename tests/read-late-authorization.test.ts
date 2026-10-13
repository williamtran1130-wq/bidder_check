import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notFound, redirect, unstable_rethrow } from "next/navigation";

type ActorState =
  | "active"
  | "signed-out"
  | "archived"
  | "pending"
  | "disabled-parent"
  | "profile-error";
const state = vi.hoisted(() => ({
  actors: [] as ActorState[],
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
    const actor = state.actors.shift() ?? "active";
    return {
      auth: {
        getUser: async () => {
          state.authCalls++;
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
          single: async () => ({
            data:
              actor === "profile-error"
                ? null
                : {
                    id: "actor",
                    role: actor === "disabled-parent" ? "bidder" : "client",
                    archived: actor === "archived",
                    approval_status:
                      actor === "pending" ? "pending" : "approved",
                  },
            error:
              actor === "profile-error"
                ? { message: "private database detail" }
                : null,
          }),
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
import { getNotificationUnreadCount } from "@/app/(workspace)/notification-actions";
import {
  getBidHistory,
  getDashboardPerformance,
} from "@/app/(workspace)/actions";
import { readReport } from "@/lib/reporting-server";
import {
  discardNotificationScope,
  notificationResource,
} from "@/lib/notification-store";

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
  state.actors = [];
  state.authCalls = 0;
  state.protectedReads = [];
  state.authError = undefined;
  state.rpc.mockReset().mockResolvedValue({ data: 3, error: null });
});
afterEach(() => {
  discardNotificationScope("late-auth:");
  vi.unstubAllGlobals();
});

describe("late authorization through actual read transport", () => {
  it.each(revokedCases)(
    "unread %s returns private %i and resets/navigates to %s",
    async (actor, status, destination) => {
      state.actors = ["active", actor];
      const response = await handleRead(
        new Request("https://local/api/read/unread"),
        "unread",
      );
      expect(state.authCalls).toBe(2);
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
      const resource = notificationResource(
        "late-auth:private",
        client.getNotificationUnreadCount,
        { data: 9 },
      );
      win.addEventListener("workspace-access-revoked", () =>
        discardNotificationScope("late-auth:"),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      await resource.refresh();
      expect(reset).toHaveBeenCalledOnce();
      expect(win.location.assign).toHaveBeenCalledExactlyOnceWith(destination);
      expect(resource.snapshot()).toEqual({});
    },
  );

  it.each(revokedCases)(
    "report %s preserves the typed failure through the report service",
    async (actor, status, destination) => {
      state.actors = ["active", actor];
      const input = encodeURIComponent(
        JSON.stringify({ period: { preset: "all" } }),
      );
      const response = await handleRead(
        new Request(`https://local/api/read/dashboard?q=${input}`),
        "dashboard",
      );
      expect(state.authCalls).toBe(2);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ destination });
      expect(state.rpc).not.toHaveBeenCalled();
    },
  );

  it("history also preserves service-side authorization without querying private history", async () => {
    state.actors = ["active", "archived"];
    const response = await handleRead(
      new Request(
        `https://local/api/read/history?q=${encodeURIComponent(JSON.stringify(bidId))}`,
      ),
      "history",
    );
    expect(state.authCalls).toBe(2);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      destination: "/auth/inactive",
    });
    expect(state.protectedReads).toEqual([]);
  });

  it.each(["profile-error", "rpc-error"] as const)(
    "%s stays a business failure and retains same-query data without navigation",
    async (failure) => {
      state.actors = [
        "active",
        failure === "profile-error" ? "profile-error" : "active",
      ];
      if (failure === "rpc-error")
        state.rpc.mockResolvedValue({
          data: null,
          error: { message: "private database detail" },
        });
      const response = await handleRead(
        new Request("https://local/api/read/unread"),
        "unread",
      );
      expect(state.authCalls).toBe(2);
      expect(response.status).toBe(200);
      expect(await response.clone().json()).toEqual({
        error: "Notifications are unavailable. Please retry.",
      });
      if (failure === "profile-error") expect(state.rpc).not.toHaveBeenCalled();
      const { win, reset } = browser();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      const resource = notificationResource(
        "late-auth:transient",
        client.getNotificationUnreadCount,
        { data: 9 },
      );
      await resource.refresh();
      expect(resource.snapshot()).toEqual({
        data: 9,
        error: "Notifications are unavailable. Please retry.",
      });
      expect(reset).not.toHaveBeenCalled();
      expect(win.location.assign).not.toHaveBeenCalled();
    },
  );

  it("preserves unrelated Next control exceptions", async () => {
    const expected = controlError(notFound);
    state.authError = expected;
    await expect(
      handleRead(new Request("https://local/api/read/unread"), "unread"),
    ).rejects.toBe(expected);
  });
});

describe("default legacy and RSC authorization behavior", () => {
  for (const [name, run] of [
    ["notification action", getNotificationUnreadCount],
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
        state.actors = [actor];
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
