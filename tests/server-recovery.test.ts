import { beforeEach, describe, expect, it, vi } from "vitest";
import { redirect, notFound } from "next/navigation";
const state = vi.hoisted(() => ({ rpc: vi.fn(), contextError: undefined as unknown, role: "client", reads: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin", () => ({ adminClient: vi.fn() }));
vi.mock("@/lib/storage-cleanup", () => ({ runStorageCleanup: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getContext: async () => {
  if (state.contextError) throw state.contextError;
  return { profile: { role: state.role, archived: false, approval_status: "approved" }, workspaces: [], supabase: { rpc: state.rpc, from: state.reads } };
} }));
import * as actions from "@/app/(workspace)/actions";
import { getNotificationUnreadCount, getNotificationPage, previewNotificationSchedule } from "@/app/(workspace)/notification-actions";
import { getScreenshotUploadContext, getScreenshotUploadHistory } from "@/app/(workspace)/upload-context-actions";

const bid = "00000000-0000-4000-8000-000000000001";
const request = "00000000-0000-4000-8000-000000000002";
const rows = [{ company: "Acme", role_name: "Engineer", url: "not a URL", source: "", arrangement: "remote", job_status: "open" }];
const query = { search: "", status: "all", arrangement: "all", resume: "all", bidder: "all", source: "all", job: "all", columnFilters: [], sorting: [], pageIndex: 0, pageSize: 10 } as const;
function controlError(run: () => never) { try { run(); } catch (error) { return error; } }
beforeEach(() => { state.contextError = undefined; state.role = "client"; state.rpc.mockReset(); state.reads.mockReset(); state.rpc.mockResolvedValue({ data: "saved", error: null }); });

describe("framework recovery at real action boundaries", () => {
  const calls = [
    ["ordinary action", () => actions.archiveResume(bid, true)],
    ["single restore", () => actions.trashBid(bid, false)],
    ["bulk restore", () => actions.bulkBidState([{ id: bid, version: 1 }], false)],
    ["legacy import", () => actions.importBids(bid, "2026-10-05", rows, request)],
    ["reviewed import", () => actions.importReviewedBids(bid, "2026-10-05", rows, [4], request)],
    ["bid list", () => actions.getBidRows("all", "", "", false, undefined, { ...query, columnFilters: [], sorting: [] })],
    ["report", () => actions.getDashboardPerformance({ period: { preset: "all" } })],
    ["notifications", getNotificationUnreadCount],
    ["upload context", () => getScreenshotUploadContext(bid)],
    ["upload history", () => getScreenshotUploadHistory(bid)],
  ] as const;
  for (const [kind, invoke] of calls) {
    it(`propagates auth redirects through ${kind}`, async () => {
      const error = controlError(() => redirect("/login")); state.contextError = error;
      await expect(invoke()).rejects.toBe(error);
    });
  }
  it("propagates not-found from the action dependency", async () => {
    const error = controlError(notFound); state.contextError = error;
    await expect(actions.archiveResume(bid, true)).rejects.toBe(error);
  });
});

it("keeps database internals out of mutation failures while preserving known domain errors", async () => {
  state.rpc.mockResolvedValue({ error: { code: "23503", message: 'insert on table "private_table" violates constraint "private_fk"', details: "private details" } });
  const result = await actions.archiveResume(bid, true);
  expect(result.error).toBeTruthy(); expect(JSON.stringify(result)).not.toMatch(/private_table|private_fk|private details/);
  state.rpc.mockResolvedValue({ error: { code: "P0001", message: "Resume is archived" } });
  expect(await actions.archiveResume(bid, true)).toEqual({ error: "Resume is archived" });
});
it("returns readable validation without a database write for malformed archive and correction inputs", async () => {
  for (const invoke of [() => actions.archiveResume("bad", true), () => actions.archiveResume(bid, "false" as unknown as boolean), () => actions.unapplyBid("bad", "correction"), () => actions.reviewClient("bad", "approved", "")]) {
    const result = await invoke(); expect(result.error).toBeTruthy(); expect(result.error).not.toMatch(/invalid_format|expected|\"path\"/);
  }
  expect(state.rpc).not.toHaveBeenCalled();
});
it("validates editable fields and value envelopes without disturbing conflict returns", async () => {
  expect(await actions.updateBidCell(bid, "rate_cents", "3", 1)).toHaveProperty("error");
  expect(await actions.updateBidCell(bid, "source", 3 as unknown as string, 1)).toHaveProperty("error");
  expect(await actions.updateBidCell(bid, "source", "x".repeat(8193), 1)).toHaveProperty("error");
  expect(state.rpc).not.toHaveBeenCalled();
  state.rpc.mockResolvedValue({ data: { conflict: true, row: { id: bid, version: 2 } } });
  expect(await actions.updateBidCell(bid, "source", "", 1)).toEqual({ data: { conflict: true, row: { id: bid, version: 2 } } });
});
it("preserves structured restoration issues and never exposes unrelated SQL failures", async () => {
  state.rpc.mockResolvedValue({ error: { code: "P0001", message: "Restoration blocked", details: JSON.stringify({ bidId: bid, issues: [{ field: "company", code: "company_limit", message: "The company limit for bids on this profile has been reached." }] }) } });
  expect(await actions.trashBid(bid, false)).toMatchObject({ issues: [{ bidId: bid, field: "company", code: "company_limit" }] });
  state.rpc.mockResolvedValue({ error: { code: "23503", message: "private SQL relation" } });
  expect(JSON.stringify(await actions.bulkBidState([{ id: bid, version: 1 }], false))).not.toContain("private SQL relation");
  state.rpc.mockResolvedValue({ error: { code: "23503", message: "private SQL relation", details: JSON.stringify({ issues: [{ message: "private SQL details" }] }) } });
  expect(JSON.stringify(await actions.trashBid(bid, false))).not.toContain("private SQL details");
});
it("validates import envelopes before RPC while retaining row-level validation and original row numbers", async () => {
  expect(await actions.importBids(bid, "2026-02-30", rows, request)).toMatchObject({ uncertain: false, error: expect.any(String) });
  expect(await actions.checkBidImport(bid, "2026-10-05", Array.from({ length: 501 }, () => rows[0]))).toHaveProperty("error");
  expect(state.rpc).not.toHaveBeenCalled();
  state.rpc.mockResolvedValue({ data: [{ row: 1, field: "url", message: "Enter a valid URL" }] });
  expect(await actions.checkBidImport(bid, "2026-10-05", rows)).toMatchObject({ data: [{ row: 1, field: "url" }] });
  expect(state.rpc).toHaveBeenCalledWith("validate_bid_import", expect.objectContaining({ p_rows: rows }));
});
it("hides unexpected import failures and preserves definite versus uncertain outcomes", async () => {
  state.rpc.mockResolvedValue({ error: { code: "23514", message: "private_check SQL details" } });
  expect(await actions.importBids(bid, "2026-10-05", rows, request)).toMatchObject({ uncertain: false });
  expect(JSON.stringify(await actions.importReviewedBids(bid, "2026-10-05", rows, [17], request))).not.toContain("private_check");
  state.rpc.mockRejectedValue(new Error("private transport details"));
  const lost = await actions.importReviewedBids(bid, "2026-10-05", rows, [17], request);
  expect(lost.uncertain).toBe(true); expect(lost.error).not.toContain("private transport");
});
it("rejects malformed upload and file identifiers before reads, reservation, or service access", async () => {
  for (const invoke of [() => actions.prepareUpload("screenshot", "bad", "image.png", "image/png", 1), () => actions.prepareUpload("unknown" as "resume", bid, "image.png", "image/png", 1), () => actions.prepareUpload("screenshot", bid, "image.png", "image/png", 1.5), () => actions.finalizeUpload("bad"), () => actions.getFileUrl("bad"), () => actions.getBidHistory("bad")]) {
    const result = await invoke(); expect(result.error).toBeTruthy();
  }
  expect(state.reads).not.toHaveBeenCalled(); expect(state.rpc).not.toHaveBeenCalled();
});
it("rejects malformed list UUID selectors before RPC but preserves all and empty selectors", async () => {
  expect(await actions.getBidRows("all", "", "", false, undefined, { ...query, resume: "bad", columnFilters: [], sorting: [] })).toHaveProperty("error");
  expect(state.rpc).not.toHaveBeenCalled();
  state.role = "bidder"; state.rpc.mockResolvedValue({ data: { rows: [], count: 0, sources: [] } });
  for (const selector of ["all", "", bid]) {
    expect(await actions.getBidRows("all", "", "", false, undefined, { ...query, resume: selector, bidder: selector, columnFilters: [], sorting: [] })).toHaveProperty("data");
  }
});
it("rejects malformed notification dates and status types before RPC", async () => {
  expect(await previewNotificationSchedule({ kind: "once", scheduled_local: "2026-02-30T09:30" })).toHaveProperty("error");
  expect(await previewNotificationSchedule({ kind: "once", scheduled_local: "2026-03-08T02:30" })).toHaveProperty("error");
  expect(await getNotificationPage({ kind: "messages", status: 1 as unknown as string })).toHaveProperty("error");
  expect(state.rpc).not.toHaveBeenCalled();
  state.rpc.mockResolvedValue({ data: { rows: [], next_cursor: null, unread_count: 0 } });
  for (const status of [undefined, "all", "draft", "active", "paused", "completed", "cancelled", "", "unknown"]) {
    expect(await getNotificationPage({ kind: "messages", status })).toHaveProperty("data");
  }
});
it("preserves valid SQL correction text without silently trimming Unicode whitespace", async () => {
  expect(await actions.unapplyBid(bid, "\u00a0Corrected\u00a0")).toHaveProperty("data");
  expect(state.rpc).toHaveBeenCalledWith("set_applied", expect.objectContaining({ p_reason: "\u00a0Corrected\u00a0" }));
});

describe("interview Central Time validation", () => {
  const interview = { bid, scheduled: true, localTime: "", notes: "", reason: "" };
  it.each(["2026-02-30T09:00", "2026-03-08T02:30", "2026-10-12T24:00", "2026-10-12", "2026-10-12T09:00Z"])("rejects invalid or nonexistent local time %s before writing", async (localTime) => {
    const result = await actions.setBidInterviewAction({ ...interview, localTime });
    expect(result.error).toMatch(/valid|clocks/i); expect(state.rpc).not.toHaveBeenCalled();
  });
  it.each([["", null], ["2020-01-01T09:30", "2020-01-01T15:30:00.000Z"], ["2026-11-01T01:30", "2026-11-01T06:30:00.000Z"]])("keeps optional/historical/first-fold input %s", async (localTime, want) => {
    await actions.setBidInterviewAction({ ...interview, localTime });
    expect(state.rpc).toHaveBeenCalledWith("set_bid_interview", expect.objectContaining({ p_at: want }));
  });
  it("preserves the database's state-dependent clear reason rule and audit text", async () => {
    state.rpc.mockResolvedValueOnce({ error: { code: "P0001", message: "A correction reason is required" } });
    expect(await actions.setBidInterviewAction({ ...interview, scheduled: false })).toEqual({ error: "A correction reason is required" });
    expect(await actions.setBidInterviewAction({ ...interview, scheduled: false, reason: "Corrected invitation" })).toHaveProperty("data");
    expect(state.rpc).toHaveBeenCalledWith("set_bid_interview", expect.objectContaining({ p_scheduled: false, p_reason: "Corrected invitation" }));
    // SQL permits an already-clear interview with no reason; the adapter must too.
    expect(await actions.setBidInterviewAction({ ...interview, scheduled: false })).toHaveProperty("data");
  });
});
it("preserves SQL character limits, literal whitespace, and unrestricted save sources", async () => {
  const company = "😀".repeat(200), source = "x".repeat(500);
  expect(await actions.updateBidCell(bid, "company", company, 1)).toHaveProperty("data");
  expect(await actions.updateBidCell(bid, "source", "\u00a0literal\u00a0", 1)).toHaveProperty("data");
  expect(state.rpc).toHaveBeenCalledWith("update_bid_cell", expect.objectContaining({ p_value: "\u00a0literal\u00a0" }));
  const form = new FormData();
  Object.entries({ resume_id: bid, company, role_name: "Role", url: "https://example.com/job", source, arrangement: "remote", job_status: "open" }).forEach(([key, value]) => form.set(key, value));
  expect(await actions.saveBid(form)).toEqual({ data: { status: "saved", id: "saved" } });
  expect(state.rpc).toHaveBeenCalledWith("save_bid", expect.objectContaining({ p_source: source, p_company: company }));
});
const invalidCellDrafts = [
  ["company", "", "Required; maximum 200 characters"],
  ["role_name", "", "Required; maximum 200 characters"],
  ["company", "😀".repeat(201), "Required; maximum 200 characters"],
  ["source", "x".repeat(201), "Maximum 200 characters"],
  ["arrangement", "invalid pasted value", "Choose remote, onsite or hybrid"],
  ["job_status", "invalid pasted value", "Choose open or closed"],
] as const;
it.each(invalidCellDrafts)("preserves the latest row for a stale invalid %s draft", async (field, value) => {
  const latest = { id: bid, version: 2, company: "Current company" };
  state.rpc.mockResolvedValue({ data: { conflict: true, row: latest } });
  expect(await actions.updateBidCell(bid, field, value, 1)).toEqual({ data: { conflict: true, row: latest } });
  expect(state.rpc).toHaveBeenCalledWith("update_bid_cell", { p_bid: bid, p_field: field, p_value: value, p_version: 1 });
});
it.each(invalidCellDrafts)("preserves SQL validation for a current-version invalid %s draft", async (field, value, message) => {
  state.rpc.mockResolvedValue({ error: { code: "P0001", message } });
  expect(await actions.updateBidCell(bid, field, value, 2)).toEqual({ error: message });
  expect(state.rpc).toHaveBeenCalledWith("update_bid_cell", { p_bid: bid, p_field: field, p_value: value, p_version: 2 });
});
