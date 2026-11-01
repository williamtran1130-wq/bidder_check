// Preview-only transport adapter. Report components and their browser cache are
// production code; mail still crosses the browser HTTP boundary for route tests.
import type { CollectionStatus, KindReport, ReportBundle, ReportKind, InterviewValue } from "../../src/lib/report-bundle";
import type { GroupedReportQuery, InterviewReport, ReportQuery, ReportResult } from "../../src/lib/report-types";
import type { MailAssignment, MailInsightsReport } from "../../src/lib/mail-insights-report";
import { buildMailInsightsUrl } from "../../src/lib/mail-insights-report";
import { calendarToday, resolveCalendarPeriod, shiftCalendarDate } from "../../src/lib/calendar-period";
import { getDashboardPerformance, getEarningsPerformance, getInterviewPerformance } from "./actions";
import { fixture } from "./sample-data";
import { activeResumes } from "../../src/lib/active-items";

export { bundleUrl } from "../../src/lib/report-bundle";
export type { CollectionStatus, KindReport, ReportBundle, ReportKind, InterviewValue } from "../../src/lib/report-bundle";

const normalized = (email: string) => email.trim().toLowerCase();
function coverage(mail: MailInsightsReport | null): CollectionStatus {
  const empty: CollectionStatus = { status: "not_synced", updatedAt: null, from: null, to: null };
  if (!mail) return empty;
  const emails = [...new Set(mail.assignments.map(row => normalized(row.email)).filter(Boolean))];
  const boxes = emails.map(email => mail.mailboxes.find(box => normalized(box.email) === email));
  const updatedAt = boxes.map(box => box?.collected_at).filter((value): value is string => !!value && Number.isFinite(Date.parse(value))).sort().at(-1) ?? null;
  if (!boxes.length || boxes.some(box => !box?.coverage_start || !box.collected_at || !Number.isFinite(Date.parse(box.collected_at)))) return { ...empty, updatedAt };
  const today = calendarToday();
  const from = [shiftCalendarDate(today, -89), ...boxes.map(box => box!.coverage_start!)].sort().at(-1)!;
  const to = [today, ...boxes.map(box => calendarToday(new Date(box!.collected_at!)))].sort()[0];
  return from <= to ? { status: "ready", updatedAt, from, to } : { ...empty, updatedAt };
}

function applicationCohort(mail: MailInsightsReport, range: { from: string; to: string }, query: ReportQuery, group: GroupedReportQuery["group"]): InterviewReport {
  const groups = new Map<string, InterviewReport["groups"][number]>();
  let applied = 0;
  for (const bid of fixture.bids) {
    if (bid.deleted_at || !bid.first_applied_at) continue;
    const date = calendarToday(new Date(bid.first_applied_at));
    if (date < range.from || date > range.to) continue;
    const assignment = mail.assignments.find(row => row.id === bid.resume_id);
    if (!assignment || (query.workspace && bid.workspace_id !== query.workspace) ||
      (query.bidder && bid.bidder_id !== query.bidder) || (query.profile && assignment.profile_id !== query.profile) ||
      (query.email && normalized(assignment.email) !== normalized(query.email))) continue;
    const id = group === "profile" ? assignment.profile_id : group === "bidder" ? assignment.bidder_id : assignment.id;
    const label = group === "profile" ? assignment.profile_label : group === "bidder" ? assignment.bidder_name : `${assignment.profile_label} · ${assignment.bidder_name}`;
    const row = groups.get(id) ?? { id, label, applied: 0, interviews: 0, conversion: null };
    row.applied++;
    applied++;
    groups.set(id, row);
  }
  return { totals: { applied, interviews: 0, excludedApplications: 0 }, groups: [...groups.values()] };
}

function invitations(mail: MailInsightsReport, range: { from: string; to: string }, assignments: MailAssignment[]) {
  const emails = new Set(assignments.map(row => normalized(row.email)));
  return mail.mailboxes.filter(box => emails.has(normalized(box.email))).reduce((total, box) => total + box.rows
    .filter(row => row.category === "interview_invite" && row.date >= range.from && row.date <= range.to)
    .reduce((sum, row) => sum + row.count, 0), 0);
}

export async function fetchReportBundle<K extends ReportKind>(kind: K, query: ReportQuery | GroupedReportQuery): Promise<ReportResult<ReportBundle<KindReport[K]>>> {
  const base = kind === "overview" ? await getDashboardPerformance(query) : kind === "earnings"
    ? await getEarningsPerformance(query as GroupedReportQuery) : await getInterviewPerformance(query as GroupedReportQuery);
  if (base.error || !base.data) return { error: base.error || "Report unavailable. Please retry.", code: "temporarily_unavailable" };
  let mail: MailInsightsReport | null = null;
  try {
    const response = await fetch(buildMailInsightsUrl(query), { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return { error: "Email insights are temporarily unavailable. Please retry.", code: response.status === 401 || response.status === 403 ? "forbidden" : "temporarily_unavailable" };
    // Vite's HTML fallback means that a scenario did not provide mail data.
    // A route returning a real failure still fails the atomic bundle above.
    if (response.headers.get("content-type")?.includes("application/json")) mail = await response.json();
  } catch { return { error: "Email insights are temporarily unavailable. Please retry.", code: "temporarily_unavailable" }; }
  const collection = coverage(mail);
  const requested = resolveCalendarPeriod(query.period);
  const from = collection.from && [collection.from, requested.from].filter((date): date is string => !!date).sort().at(-1)!;
  const to = collection.to && [collection.to, requested.to].filter((date): date is string => !!date).sort()[0];
  const interviewPeriod = collection.status === "ready" && from && to && from <= to ? { from, to } : null;
  const group = "group" in query ? query.group : "profile";
  const cohort = mail && interviewPeriod ? applicationCohort(mail, interviewPeriod, query, group) : { totals: { applied: 0, interviews: 0, excludedApplications: 0 }, groups: [] };
  const rate = (count: number, applications: number): number | null => applications ? Math.round(count / applications * 1000) / 10 : null;
  let interview: InterviewValue & { groups: Record<string, InterviewValue> } = { invitations: null, applications: null, rate: null, groups: {} };
  if (mail && interviewPeriod) {
    const total = invitations(mail, interviewPeriod, mail.assignments);
    interview = { invitations: total, applications: cohort.totals.applied, rate: rate(total, cohort.totals.applied), groups: {} };
    for (const row of cohort.groups) {
      const assignments = mail.assignments.filter(assignment => (group === "profile" ? assignment.profile_id : group === "bidder" ? assignment.bidder_id : assignment.id) === row.id);
      const count = invitations(mail, interviewPeriod, assignments);
      interview.groups[row.id] = { invitations: count, applications: row.applied, rate: rate(count, row.applied) };
    }
    if (kind === "interviews") mail = { ...mail, range: { ...interviewPeriod, clipped: false } };
  }
  // Mirror the final display projection in workspace_report_bundle, after all
  // historical totals, coverage, and rate calculations have completed.
  const assignments = activeResumes(fixture);
  const activeIds = (dimension: string) => new Set(assignments.map(row => dimension === "bidder" ? row.bidder_id : dimension === "profile" ? row.profile_id : row.id));
  const source = (kind === "interviews" ? cohort : base.data) as KindReport[K];
  const report = "comparisons" in source ? { ...source, comparisons: {
    bidders: source.comparisons.bidders.filter(row => activeIds("bidder").has(row.id)),
    profiles: source.comparisons.profiles.filter(row => activeIds("profile").has(row.id)),
  } } : { ...source, groups: source.groups.filter(row => activeIds(group).has(row.id)) };
  // Some transport tests supply their own independent authorized identities.
  // Apply fixture mutations only to fixture-owned rows; retain those mocks' flags.
  if (mail) mail = { ...mail, assignments: mail.assignments.map(row => ({ ...row, archived: row.archived || (fixture.resumes.some(assignment => assignment.id === row.id) && !activeIds("assignment").has(row.id)) })) };
  return { data: { report: report as KindReport[K], mail, collection, interviewPeriod, interview } };
}
