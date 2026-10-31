import { describe, expect, it, vi, afterEach } from "vitest";
import { aggregateMailInsights, buildMailInsightsUrl, fetchMailInsights } from "@/lib/mail-insights-report";
import type { MailInsightsReport, MailCubeRow } from "@/lib/mail-insights-report";

const cube = (category: string, count: number, rest: Partial<MailCubeRow> = {}): MailCubeRow => ({ date: "2026-10-29", category, count, handled: false, action_required: false, retryable: false, ...rest });
export const sample: MailInsightsReport = {
  status: "ready", received_at: "2026-10-30T15:00:00Z", generated_at: "2026-10-30T14:59:00Z",
  range: { from: "2026-10-29", to: "2026-10-30", clipped: false },
  mailboxes: [
    { email: "shared@example.test", account_label: "Shared", collected_at: "2026-10-30T14:00:00Z", coverage_start: "2026-10-01", rows: [cube("interview_invite", 2), cube("application_ack", 3, { handled: true }), cube("unclassified", 4, { action_required: true, retryable: true }), cube("rejection", 5, { action_required: true }), cube("offer", 99, { date: "2026-10-28" })] },
    { email: "unassigned@example.test", account_label: "Unassigned", collected_at: null, coverage_start: null, rows: [cube("offer", 1)] },
  ],
  assignments: [
    { id: "a1", workspace_id: "w", bidder_id: "b1", bidder_name: "Alex", profile_id: "p1", profile_label: "Profile one", email: "shared@example.test", archived: false },
    { id: "a2", workspace_id: "w", bidder_id: "b2", bidder_name: "Blair", profile_id: "p1", profile_label: "Profile one", email: "shared@example.test", archived: false },
    { id: "a3", workspace_id: "w", bidder_id: "b1", bidder_name: "Alex", profile_id: "p2", profile_label: "Profile two", email: "missing@example.test", archived: false },
  ],
  bid_rows: [
    { date: "2026-10-29", workspace_id: "w", bidder_id: "b1", profile_id: "p1", assignment_id: "a1", email: "shared@example.test", found: 5, applied: 2 },
    { date: "2026-10-30", workspace_id: "w", bidder_id: "b2", profile_id: "p1", assignment_id: "a2", email: "shared@example.test", found: 4, applied: 3 },
    { date: "2026-10-29", workspace_id: "w", bidder_id: "b1", profile_id: "p2", assignment_id: "a3", email: "missing@example.test", found: 7, applied: 1 },
    { date: "2026-10-28", workspace_id: "w", bidder_id: "b1", profile_id: "p1", assignment_id: "a1", email: "shared@example.test", found: 100, applied: 100 },
  ],
};

describe("mail insights scoped cube", () => {
  it("groups by assignment IDs without combining two assignments sharing a mailbox", () => {
    const result = aggregateMailInsights(sample, {}, "assignment" as never, false);
    expect(result.groups.map(row => row.id).sort()).toEqual(["a1", "a2", "a3"]);
    expect(result.groups.find(row => row.id === "a1")?.categories?.application_ack).toBe(3);
    expect(result.groups.find(row => row.id === "a2")?.found).toBe(4);
    expect(result.categories.application_ack).toBe(3);
  });
  it("uses the same inclusive dates for mail and bid activity and category-tier attention semantics", () => {
    const result = aggregateMailInsights(sample);
    expect(result.summary).toEqual({ total: 15, pendingAttention: 7, completed: 3, unclassified: 4, retryable: 4 });
    expect(result.totals.found).toBe(16);
    expect(result.totals.applied).toBe(6);
    expect(result.categories.application_ack).toBe(3);
    expect(result.categories.job_alert).toBe(0);
    expect(result.daily.map(row => row.date)).toEqual(["2026-10-29", "2026-10-30"]);
    expect(result.daily[0].offer).toBe(1);
  });
  it("refines all mail counts by cube category, status and action without filtering bid activity", () => {
    const result = aggregateMailInsights(sample, { categories: ["unclassified", "rejection"], status: "pending", action: "yes" });
    expect(result.summary).toEqual({ total: 9, pendingAttention: 4, completed: 0, unclassified: 4, retryable: 4 });
    expect(result.totals.found).toBe(16);
    expect(aggregateMailInsights(sample, { status: "done", action: "no" }).summary.total).toBe(3);
    expect(aggregateMailInsights(sample, { action: "no" }).summary.total).toBe(6);
  });
  it("counts a shared mailbox once globally and per profile while retaining each bidder's activity", () => {
    const result = aggregateMailInsights(sample, {}, "profile");
    const row = result.groups.find(row => row.id === "p1")!;
    expect(row.categories?.application_ack).toBe(3);
    expect(row.categories?.interview_invite).toBe(2);
    expect(row.found).toBe(9);
    expect(row.applied).toBe(5);
    expect(row.shared).toBe(true);
    expect(result.categories.application_ack).toBe(3);
    const bidders = aggregateMailInsights(sample, {}, "bidder");
    expect(bidders.groups.find(row => row.id === "b1")?.categories?.application_ack).toBe(3);
    expect(bidders.groups.find(row => row.id === "b2")?.categories?.application_ack).toBe(3);
    expect(bidders.categories.application_ack).toBe(3);
  });
  it("preserves unsynced assignment bid counts and identifies uploaded unassigned mailboxes", () => {
    const result = aggregateMailInsights(sample);
    expect(result.groups.find(row => row.id === "missing@example.test")).toMatchObject({ found: 7, applied: 1, syncStatus: "not_synced", categories: null });
    expect(result.groups.find(row => row.id === "unassigned@example.test")).toMatchObject({ unassigned: true, syncStatus: "ready", label: "unassigned@example.test" });
    expect(aggregateMailInsights(sample, {}, "email", false).groups.some(row => row.unassigned)).toBe(false);
  });
  it("does not fabricate zero mail counts for a report with no snapshots", () => {
    const result = aggregateMailInsights({ ...sample, mailboxes: [], status: "not_synced" });
    expect(result.groups.find(row => row.id === "shared@example.test")?.categories).toBeNull();
    expect(result.groups.find(row => row.id === "shared@example.test")?.found).toBe(9);
  });
  it("keeps out-of-retention mailbox values unavailable instead of displaying authoritative zeros", () => {
    const result = aggregateMailInsights({ ...sample, range: { ...sample.range, empty: true }, mailboxes: sample.mailboxes.map(row => ({ ...row, rows: [] })) });
    expect(result.groups.find(row => row.id === "shared@example.test")).toMatchObject({ syncStatus: "unavailable", categories: null });
  });
  it("preserves server-authorized archived assignments and their historical bid counts", () => {
    const result = aggregateMailInsights({ ...sample, assignments: sample.assignments.map(row => ({ ...row, archived: true })) });
    expect(result.groups.find(row => row.id === "shared@example.test")).toMatchObject({ found: 9, applied: 5, unassigned: false });
    expect(result.groups.find(row => row.id === "missing@example.test")).toMatchObject({ found: 7, applied: 1, unassigned: false });
  });
});

describe("mail report transport", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends shared CT period and scope filters using the public report query contract", () => {
    const url = buildMailInsightsUrl({ period: { preset: "this_week" }, workspace: "w", bidder: "b", profile: "p", email: "a+tag@example.test" }, new Date("2026-10-30T01:00:00Z"));
    expect(url).toBe("/api/mail-insights/report?from=2026-10-26&to=2026-10-29&workspace=w&bidder=b&profile=p&email=a%2Btag%40example.test");
    expect(buildMailInsightsUrl({ period: { preset: "all" } })).toBe("/api/mail-insights/report");
  });
  it("treats missing preview endpoints, malformed payloads and network failures as independent mail errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>preview</html>")));
    expect(await fetchMailInsights({ period: { preset: "all" } })).toMatchObject({ error: expect.stringContaining("Email insights") });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [] })));
    expect(await fetchMailInsights({ period: { preset: "all" } })).toMatchObject({ error: expect.any(String) });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await fetchMailInsights({ period: { preset: "all" } })).toMatchObject({ error: expect.any(String) });
  });
  it("rejects malformed cube rows and impossible ranges before they can break the main dashboard render", async () => {
    for (const broken of [
      { ...sample, mailboxes: [{ email: "broken@example.test" }] },
      { ...sample, range: { from: "2026-02-31", to: "2026-10-30", clipped: false } },
      { ...sample, mailboxes: [{ ...sample.mailboxes[0], rows: [{ ...sample.mailboxes[0].rows[0], count: "2" }] }] },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(broken)));
      expect(await fetchMailInsights({ period: { preset: "all" } })).toMatchObject({ error: expect.any(String) });
    }
  });
  it("reads the raw scoped report without turning a 403 into usable stale data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(sample)));
    expect(await fetchMailInsights({ period: { preset: "all" } })).toEqual({ data: sample });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Denied" }, { status: 403 })));
    expect(await fetchMailInsights({ period: { preset: "all" } })).toMatchObject({ code: "forbidden", error: expect.any(String) });
  });
});

it("preserves the workspace-selection API instruction as an actionable email-only error", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Choose a workspace to view email insights." }, { status: 400 })));
  expect(await fetchMailInsights({ period: { preset: "all" } })).toMatchObject({ error: "Choose a workspace to view email insights." });
  vi.unstubAllGlobals();
});
