import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Dashboard } from "@/components/dashboard";
import type { DashboardData } from "@/lib/data";
import type { DashboardReport } from "@/lib/report-types";
import type { ReportBundle } from "@/lib/report-bundle";
import { calendarToday } from "@/lib/calendar-period";
import { readKey } from "@/lib/read-state";
const fixture: DashboardData = { profile: { id: "client", display_name: "Alex", email: "alex@example.test", role: "client", approval_status: "approved", approval_reason: null, reviewed_at: null, reviewed_by: null, archived: false, created_at: "2026-10-30T00:00:00Z" }, workspaces: [], profiles: [], bidders: [], candidateProfiles: [] };
it("places Email insights below original comparisons with This week default", () => {
  const html = renderToStaticMarkup(createElement(Dashboard, { data: fixture }));
  expect(html.indexOf('aria-label="Email insights"')).toBeGreaterThan(html.indexOf('aria-label="Application activity"'));
  expect(html.indexOf('aria-label="Email insights"')).toBeGreaterThan(html.indexOf("By profile"));
  expect(html).toContain("Confirmation emails");
  expect(html).toContain("Interview invites");
  expect(html).not.toContain("Interview rate");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('<option value="this_week" selected="">This week</option>');
  expect(html).toContain("By profile");
});

function summary(role: "client" | "bidder" = "client", synced = true) {
  const day = calendarToday(), now = new Date().toISOString();
  const bundle: ReportBundle<DashboardReport> = {
    report: { range: { from: day, to: day, bucketUnit: "day", bucketSize: 1 },
      totals: { found: 10, foundApplied: 3, appliedActivity: 7, trackedApplications: 7, trackedInterviews: 0 },
      series: [], comparisons: { bidders: [], profiles: [] }, financial: { earningsCents: 12500, earningsCount: 7 } },
    mail: synced ? { status: "ready", received_at: now, generated_at: now, range: { from: day, to: day, clipped: false },
      mailboxes: [{ email: "mail@example.test", account_label: "Mail", collected_at: now, coverage_start: day, rows: [
        { date: day, category: "application_ack", count: 11, handled: false, action_required: false, retryable: false },
        { date: day, category: "interview_invite", count: 2, handled: false, action_required: true, retryable: false },
      ] }], assignments: [{ id: "assignment", workspace_id: "workspace", bidder_id: "bidder", bidder_name: "Bidder", profile_id: "profile", profile_label: "Profile", email: "mail@example.test", archived: false }], bid_rows: [] } : null,
    collection: { status: "not_synced", updatedAt: null, from: null, to: null }, interviewPeriod: null,
    interview: { applications: null, invitations: null, rate: null, groups: {} },
  };
  const html = renderToStaticMarkup(createElement(Dashboard, { data: { ...fixture, profile: { ...fixture.profile, role } },
    initial: { key: readKey("", "bundle-overview", { period: { preset: "this_week" } }, day), result: { data: bundle }, receivedAt: Date.now() } }));
  return html.match(/<section[^>]*aria-label="Dashboard summary"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
}
it("shows the requested five totals in order, using applied activity and mail message counts", () => {
  const html = summary();
  expect([...html.matchAll(/role="group" aria-label="([^"]+)"/g)].map(match => match[1])).toEqual(["Bids found", "Bids applied", "Confirmation email", "Interview invites", "Earned"]);
  expect([...html.matchAll(/<p class="mt-3[^"]*">([^<]+)<\/p>/g)].map(match => match[1])).toEqual(["10", "7", "11", "2", "$125.00"]);
});
it("keeps earnings hidden for bidders even when a report carries financial data", () => {
  const html = summary("bidder");
  expect(html).toContain("Interview invites");
  expect(html).not.toContain("Earned");
  expect(html).not.toContain("$125.00");
});
it("shows unavailable email totals without replacing them with zero", () => {
  const html = summary("client", false);
  expect([...html.matchAll(/<p class="mt-3[^"]*">([^<]+)<\/p>/g)].map(match => match[1])).toEqual(["10", "7", "—", "—", "$125.00"]);
});
