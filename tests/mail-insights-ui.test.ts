import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EmailInsightsView } from "@/components/email-insights";
import type { MailInsightsReport } from "@/lib/mail-insights-report";
const report: MailInsightsReport = {
  status: "ready", received_at: "2026-10-30T15:00:00Z", generated_at: "2026-10-30T14:00:00Z", range: { from: "2026-08-02", to: "2026-10-30", clipped: true },
  mailboxes: [{ email: "team@example.test", account_label: "Team", collected_at: null, coverage_start: null, rows: [{ date: "2026-10-29", category: "application_ack", handled: true, action_required: false, retryable: false, count: 3 }] }, { email: "spare@example.test", account_label: "Spare", collected_at: null, coverage_start: null, rows: [] }],
  assignments: [
    { id: "a1", workspace_id: "w", bidder_id: "b1", bidder_name: "Alex", profile_id: "p", profile_label: "Candidate", email: "team@example.test", archived: false },
    { id: "a2", workspace_id: "w", bidder_id: "b2", bidder_name: "Blair", profile_id: "p", profile_label: "Candidate", email: "team@example.test", archived: false },
    { id: "a3", workspace_id: "w", bidder_id: "b1", bidder_name: "Alex", profile_id: "p2", profile_label: "Missing profile", email: "missing@example.test", archived: false },
  ],
  bid_rows: [{ date: "2026-10-29", workspace_id: "w", bidder_id: "b1", profile_id: "p2", assignment_id: "a3", email: "missing@example.test", found: 7, applied: 2 }],
};
const noop = () => {};
const props = { report, loading: false, isManager: true, email: "", onEmailChange: noop, filters: {}, onFiltersChange: noop, group: "email" as const, onGroupChange: noop, onRefresh: noop };
it("omits archived assignment names and their exclusive email choices while retaining collected totals",()=>{
  const html=renderToStaticMarkup(createElement(EmailInsightsView,{...props,report:{...report,assignments:report.assignments.map(row=>({...row,archived:true}))}}));
  expect(html).not.toContain("Alex");expect(html).not.toContain("Blair");expect(html).not.toContain("Missing profile");
  expect(html).not.toContain('value="team@example.test"');
  expect(html).toContain('value="spare@example.test"');
  expect(html).toContain("Messages collected");
  expect(html).toContain('>3</p>');
});
it("renders all ten category totals, four mail cards, shared current assignments and missing sync distinctly", () => {
  const html = renderToStaticMarkup(createElement(EmailInsightsView, props));
  expect(html).toContain("Confirmation emails");
  expect(html).toContain("Messages collected");
  expect(html).toContain("Need your attention");
  expect(html).toContain("Completed");
  expect(html).toContain("Unclassified");
  expect(html).toContain("Information requests");
  expect(html).toContain("Recruiter outreach");
  expect(html).toContain("Job alerts");
  expect(html).not.toContain("Shared mailbox");
  expect(html).toContain("Current assignments");
  expect(html).toContain("Not synced");
  expect(html).toContain("Unassigned");
  expect(html).not.toContain("Coverage unknown");
  expect(html).not.toContain("Published:");
  expect(html).toContain("Applied activity");
  expect(html).not.toContain("conversion");
});
it("offers bidder grouping to managers and only Email/Profile to bidders", () => {
  const manager = renderToStaticMarkup(createElement(EmailInsightsView, props));
  const bidder = renderToStaticMarkup(createElement(EmailInsightsView, { ...props, isManager: false }));
  expect(manager).toContain('role="tab" aria-selected="false">Bidder');
  expect(bidder).not.toContain('role="tab" aria-selected="false">Bidder');
  expect(bidder).not.toContain("spare@example.test");
  expect(bidder).toContain('role="tab" aria-selected="true">Email');
  expect(bidder).toContain('role="tab" aria-selected="false">Profile');
});
it("keeps unavailable mail isolated with its own retry and no invented zero snapshot counts", () => {
  const html = renderToStaticMarkup(createElement(EmailInsightsView, { ...props, report: undefined, error: "Email insights are temporarily unavailable." }));
  expect(html).toContain("Email insights are temporarily unavailable.");
  expect(html).toContain("Retry email insights");
  expect(html).not.toContain("team@example.test");
  const unsynced = renderToStaticMarkup(createElement(EmailInsightsView, { ...props, report: { ...report, status: "not_synced", mailboxes: [] } }));
  expect(unsynced).toContain("Not synced");
  expect(unsynced).toContain("missing@example.test");
  expect(unsynced).toContain(">7</td>");
});

it("shows unavailable retained metrics instead of zero for a clipped range with no overlap", () => {
  const html = renderToStaticMarkup(createElement(EmailInsightsView, { ...props, report: { ...report, range: { ...report.range, empty: true }, mailboxes: report.mailboxes.map(row => ({ ...row, rows: [] })) } }));
  expect(html).toContain("No retained email data overlaps this period");
  expect(html).not.toContain("Email category chart: 0 messages");
});
it("hides archived assignment rows and retains historical table totals", () => {
  const html = renderToStaticMarkup(createElement(EmailInsightsView, { ...props, report: { ...report, assignments: report.assignments.map(row => ({ ...row, archived: true })) } }));
  expect(html).not.toContain("Archived assignment");
  expect(html).not.toContain("missing@example.test");
  expect(html).toContain(">7</td>");
});
