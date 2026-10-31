import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ role: "client", rpc: vi.fn(), destination: "" as "" | "/auth/login" | "/auth/approval" | "/auth/inactive" }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", async () => {
  const { AuthorizationError } = await import("@/lib/authorization-error");
  return { AuthorizationError, getActor: async () => {
    if (state.destination) throw new AuthorizationError(state.destination);
    return { profile: { role: state.role }, user: { id: "actor" }, supabase: { rpc: state.rpc } };
  } };
});
import { handleReportBundle, readReportBundle } from "@/lib/report-bundle-server";
beforeEach(() => { state.role = "client"; state.destination = ""; state.rpc.mockReset().mockResolvedValue({ data: { report: {}, mail: null, collection: { status: "not_synced" }, interview: { rate: null } }, error: null }); });
it("returns one private report bundle and validates dates before querying", async () => {
  const response = await handleReportBundle(new Request("https://local/api/reports/overview"), "overview");
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(state.rpc).toHaveBeenCalledOnce(); expect(state.rpc.mock.calls[0][0]).toBe("workspace_report_bundle");
  state.rpc.mockClear();
  expect((await handleReportBundle(new Request("https://local/api/reports/overview?from=2026-02-31&to=2026-03-01"), "overview")).status).toBe(400);
  expect(state.rpc).not.toHaveBeenCalled();
});
it("classifies legacy SQL permission denials as forbidden instead of transient data failures", async () => {
  state.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "Access denied" } });
  expect((await handleReportBundle(new Request("https://local/api/reports/overview"), "overview")).status).toBe(403);
  expect(await readReportBundle("overview", { period: { preset: "all" } })).toMatchObject({ code: "forbidden" });
});
it("blocks financial bundles immediately after a role changes to bidder", async () => {
  state.role = "bidder";
  expect((await handleReportBundle(new Request("https://local/api/reports/earnings"), "earnings")).status).toBe(403);
  expect(await readReportBundle("earnings", { period: { preset: "all" } })).toMatchObject({ code: "forbidden" });
  expect(state.rpc).not.toHaveBeenCalled();
});
it("preserves typed account revocation without exposing internal errors", async () => {
  state.destination = "/auth/inactive";
  const response = await handleReportBundle(new Request("https://local/api/reports/overview"), "overview");
  expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ destination: "/auth/inactive" });
  expect(state.rpc).not.toHaveBeenCalled();
  state.destination = ""; state.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "private SQL details" } });
  const failure = await handleReportBundle(new Request("https://local/api/reports/overview"), "overview");
  expect(failure.status).toBe(503); expect(JSON.stringify(await failure.json())).not.toContain("private SQL details");
});
