import { beforeEach, expect, it, vi } from "vitest";
const { rpc, context } = vi.hoisted(() => ({ rpc: vi.fn(), context: { role: "client" } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin", () => ({ adminClient: vi.fn() }));
vi.mock("@/lib/storage-cleanup", () => ({ runStorageCleanup: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getContext: async () => ({ profile: { role: context.role }, supabase: { rpc } }) }));
import { getDashboardPerformance, getEarningsPerformance, getInterviewPerformance, saveBid } from "@/app/(workspace)/actions";
beforeEach(() => { rpc.mockReset(); context.role = "client"; });
it("does not expose raw SQL failures from dashboard reports", async () => {
  rpc.mockResolvedValue({ error: { code: "57014", message: "canceling statement due to statement timeout" } });
  const result = await getDashboardPerformance({ period: { preset: "all" } });
  expect(result).toMatchObject({ code: "temporarily_unavailable" });
  expect(result.error).not.toMatch(/statement|SQL|57014/);
  expect(result.data).toBeUndefined();
});
it("validates incomplete custom dates without calling the database", async () => {
  const result = await getDashboardPerformance({ period: { preset: "custom", from: "", to: "2026-10-12" } });
  expect(result.code).toBe("validation");
  expect(rpc).not.toHaveBeenCalled();
});
it("distinguishes permanent report failures and access denial from transient timeouts", async () => {
  rpc.mockResolvedValue({ error: { code: "PGRST202", message: "Schema cache function missing" } });
  expect(await getDashboardPerformance({ period: { preset: "all" } })).toMatchObject({ code: "unavailable" });
  rpc.mockResolvedValue({ error: { code: "42501", message: "permission denied for table bids" } });
  const denied = await getDashboardPerformance({ period: { preset: "all" } });
  expect(denied.code).toBe("forbidden");
  expect(denied.error).not.toContain("table bids");
});
it("treats an empty database response as unavailable rather than a successful empty report", async () => {
  rpc.mockResolvedValue({ data: null, error: null });
  const result = await getDashboardPerformance({ period: { preset: "all" } });
  expect(result.error).toBeTruthy();
  expect(result.data).toBeUndefined();
});
it("denies bidder earnings while keeping nonfinancial interviews available", async () => {
  context.role = "bidder";
  expect(await getEarningsPerformance({ period: { preset: "all" }, group: "bidder" })).toMatchObject({ code: "forbidden" });
  expect(rpc).not.toHaveBeenCalled();
  rpc.mockResolvedValue({ data: { totals: { applied: 2, interviews: 1, excludedApplications: 0 }, groups: [] }, error: null });
  expect(await getInterviewPerformance({ period: { preset: "all" }, group: "profile" })).toMatchObject({ data: { totals: { applied: 2 } } });
  expect(rpc).toHaveBeenCalledWith("interview_performance", expect.objectContaining({ p_from: null, p_to: null }));
});
function bidForm(existing = false) {
  const form = new FormData();
  Object.entries({ id: existing ? "00000000-0000-4000-8000-000000000002" : "", resume_id: "00000000-0000-4000-8000-000000000001", url: "https://example.com/job", company: "Acme", role_name: "Engineer", source: "Example", arrangement: "remote", job_status: "open" }).forEach(([key, value]) => form.set(key, value));
  return form;
}
it("turns only creation eligibility rejections into blocked outcomes", async () => {
  rpc.mockResolvedValue({ error: { code: "PBC01", message: "Blocked" } });
  expect(await saveBid(bidForm())).toEqual({ data: { status: "blocked" } });
  expect(await saveBid(bidForm(true))).toMatchObject({ error: "Blocked" });
  rpc.mockResolvedValue({ error: { code: "P0001", message: "Assignment unavailable" } });
  expect(await saveBid(bidForm())).toEqual({ error: "Assignment unavailable" });
});
it("returns a saved outcome only after creation succeeds", async () => {
  rpc.mockResolvedValue({ data: "saved-id", error: null });
  expect(await saveBid(bidForm())).toEqual({ data: { status: "saved", id: "saved-id" } });
});
