import { z } from "zod";
import { isCalendarDate, resolveCalendarPeriod, shiftCalendarDate } from "./calendar-period";
import type { ReportQuery, ReportResult } from "./report-types";

export const MAIL_CATEGORIES = [
  { id: "interview_invite", label: "Interview emails", color: "var(--category-interview_invite-fill)" },
  { id: "assessment", label: "Assessments", color: "var(--category-assessment-fill)" },
  { id: "offer", label: "Offers", color: "var(--category-offer-fill)" },
  { id: "info_request", label: "Information requests", color: "var(--category-info_request-fill)" },
  { id: "recruiter_outreach", label: "Recruiter outreach", color: "var(--category-recruiter_outreach-fill)" },
  { id: "rejection", label: "Rejections", color: "var(--category-rejection-fill)" },
  { id: "application_ack", label: "Confirmation emails", color: "var(--category-application_ack-fill)" },
  { id: "job_alert", label: "Job alerts", color: "var(--category-job_alert-fill)" },
  { id: "other", label: "Other", color: "var(--category-other-fill)" },
  { id: "unclassified", label: "Unclassified", color: "var(--category-unclassified-fill)" },
] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number]["id"];
export type CategoryCounts = Record<MailCategory, number>;
export type MailCubeRow = { date: string; category: string; handled: boolean; action_required: boolean; retryable: boolean; count: number };
export type MailboxSnapshot = { email: string; account_label: string; collected_at: string | null; coverage_start: string | null; rows: MailCubeRow[] };
export type MailAssignment = { id: string; workspace_id: string; bidder_id: string; bidder_name: string; profile_id: string; profile_label: string; email: string; archived: boolean };
export type MailBidRow = { date: string; workspace_id: string; bidder_id: string; profile_id: string; assignment_id: string; email: string; found: number; applied: number };
export type MailInsightsReport = {
  mailboxes: MailboxSnapshot[]; assignments: MailAssignment[]; bid_rows: MailBidRow[];
  received_at: string | null; generated_at: string | null;
  range: { from: string; to: string; clipped: boolean; empty?: boolean }; status: "ready" | "not_synced";
};
export type MailFilters = { categories?: string[]; status?: "all" | "pending" | "done"; action?: "all" | "yes" | "no" };
export type MailGroup = "email" | "profile" | "bidder" | "assignment";
export type MailCombinedRow = { id: string; label: string; emails: string[]; assignments: MailAssignment[]; shared: boolean; unassigned: boolean; syncStatus: "ready" | "partial" | "not_synced" | "unavailable"; found: number; applied: number; categories: CategoryCounts | null };
/** Display-only projection; historical counters and deduplicated totals stay intact. */
export function visibleMailGroups(groups: MailCombinedRow[]): MailCombinedRow[] {
  return groups.filter(row => row.unassigned || row.assignments.some(assignment => !assignment.archived))
    .map(row => ({ ...row, assignments: row.assignments.filter(assignment => !assignment.archived) }));
}
export function selectableMailboxes(report: MailInsightsReport | undefined, includeUnassigned: boolean): string[] {
  if (!report) return [];
  const assigned = new Set(report.assignments.map(row => normalizeEmail(row.email)));
  const active = new Set(report.assignments.filter(row => !row.archived).map(row => normalizeEmail(row.email)));
  if (includeUnassigned) for (const row of report.mailboxes) {
    const email = normalizeEmail(row.email);
    if (!assigned.has(email)) active.add(email);
  }
  return [...active].sort();
}
const attention = new Set(["interview_invite", "assessment", "offer", "info_request", "recruiter_outreach", "unclassified"]);
const normalizeEmail = (value: string) => value.trim().toLowerCase();
const emptyCounts = (): CategoryCounts => Object.fromEntries(MAIL_CATEGORIES.map(({ id }) => [id, 0])) as CategoryCounts;
const dateSchema = z.string().refine(isCalendarDate);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reportSchema = z.object({
  status: z.enum(["ready", "not_synced"]), received_at: z.string().nullable(), generated_at: z.string().nullable(),
  range: z.object({ from: dateSchema, to: dateSchema, clipped: z.boolean(), empty: z.boolean().optional() }).refine(range => range.from <= range.to),
  mailboxes: z.array(z.object({ email: z.string(), account_label: z.string(), collected_at: z.string().nullable(), coverage_start: dateSchema.nullable(), rows: z.array(z.object({ date: dateSchema, category: z.string(), handled: z.boolean(), action_required: z.boolean(), retryable: z.boolean(), count: countSchema })) })),
  assignments: z.array(z.object({ id: z.string(), workspace_id: z.string(), bidder_id: z.string(), bidder_name: z.string(), profile_id: z.string(), profile_label: z.string(), email: z.string(), archived: z.boolean() })),
  bid_rows: z.array(z.object({ date: dateSchema, workspace_id: z.string(), bidder_id: z.string(), profile_id: z.string(), assignment_id: z.string(), email: z.string(), found: countSchema, applied: countSchema })),
});

/** Aggregate only the server-authorized projection. Mailbox counts are sets per group. */
export function aggregateMailInsights(report: MailInsightsReport, filters: MailFilters = {}, group: MailGroup = "email", includeUnassigned = true) {
  const { from, to } = report.range;
  const inRange = (date: string) => date >= from && date <= to;
  const assignments = report.assignments;
  const assignmentEmails = new Set(assignments.map(row => normalizeEmail(row.email)));
  const mailboxes = new Map(report.mailboxes.filter(row => includeUnassigned || assignmentEmails.has(normalizeEmail(row.email))).map(row => [normalizeEmail(row.email), row]));
  const categories = emptyCounts();
  const summary = { total: 0, pendingAttention: 0, completed: 0, unclassified: 0, retryable: 0 };
  const daily = new Map<string, { date: string } & CategoryCounts>();
  // A report range is bounded by the server to 90 days, even for All time.
  for (let date = from; date <= to && daily.size < 90; date = shiftCalendarDate(date, 1)) daily.set(date, { date, ...emptyCounts() });
  const mailboxCounts = new Map<string, CategoryCounts>();
  for (const [email, mailbox] of mailboxes) {
    const counts = emptyCounts();
    for (const row of mailbox.rows) {
      if (!inRange(row.date) || (filters.categories?.length && !filters.categories.includes(row.category)) ||
        (filters.status === "pending" && row.handled) || (filters.status === "done" && !row.handled) ||
        (filters.action === "yes" && !row.action_required) || (filters.action === "no" && row.action_required)) continue;
      const category = row.category in counts ? row.category as MailCategory : "unclassified";
      counts[category] += row.count;
      categories[category] += row.count;
      const day = daily.get(row.date);
      if (day) day[category] += row.count;
      summary.total += row.count;
      if (!row.handled && attention.has(category)) summary.pendingAttention += row.count;
      if (row.handled) summary.completed += row.count;
      if (category === "unclassified") summary.unclassified += row.count;
      if (row.retryable) summary.retryable += row.count;
    }
    if (!report.range.empty) mailboxCounts.set(email, counts);
  }
  const groups = new Map<string, MailCombinedRow>();
  const ensure = (id: string, label: string, email: string, assignment?: MailAssignment) => {
    let row = groups.get(id);
    if (!row) { row = { id, label, emails: [], assignments: [], shared: false, unassigned: !assignment, syncStatus: "not_synced", found: 0, applied: 0, categories: null }; groups.set(id, row); }
    if (!row.emails.includes(email)) row.emails.push(email);
    if (assignment && !row.assignments.some(item => item.id === assignment.id)) row.assignments.push(assignment);
    return row;
  };
  for (const assignment of assignments) {
    const email = normalizeEmail(assignment.email);
    const id = group === "email" ? email : group === "profile" ? assignment.profile_id : group === "assignment" ? assignment.id : assignment.bidder_id;
    ensure(id, group === "email" ? email : group === "profile" ? assignment.profile_label : group === "assignment" ? `${assignment.profile_label} · ${assignment.bidder_name}` : assignment.bidder_name, email, assignment);
  }
  if (includeUnassigned) for (const email of mailboxes.keys()) if (!assignmentEmails.has(email)) ensure(group === "email" ? email : "unassigned", group === "email" ? email : "Unassigned", email);
  const bids = report.bid_rows.filter(row => inRange(row.date));
  for (const bid of bids) {
    const id = group === "email" ? normalizeEmail(bid.email) : group === "profile" ? bid.profile_id : group === "assignment" ? bid.assignment_id : bid.bidder_id;
    const row = groups.get(id);
    if (row) { row.found += bid.found; row.applied += bid.applied; }
  }
  for (const row of groups.values()) {
    let synced = 0;
    for (const email of row.emails) {
      if (assignments.filter(item => normalizeEmail(item.email) === email).length > 1) row.shared = true;
      const counts = mailboxCounts.get(email);
      if (!counts) continue;
      synced++;
      row.categories ??= emptyCounts();
      for (const { id } of MAIL_CATEGORIES) row.categories[id] += counts[id];
    }
    row.syncStatus = report.range.empty ? "unavailable" : synced === 0 ? "not_synced" : synced === row.emails.length ? "ready" : "partial";
  }
  return { summary, categories, daily: [...daily.values()], groups: [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)), totals: { found: bids.reduce((n, row) => n + row.found, 0), applied: bids.reduce((n, row) => n + row.applied, 0) } };
}

export function buildMailInsightsUrl(query: ReportQuery & { email?: string }, now = new Date()) {
  const range = resolveCalendarPeriod(query.period, now);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ from: range.from, to: range.to, workspace: query.workspace, bidder: query.bidder, profile: query.profile, email: query.email })) if (value) params.set(key, value);
  return `/api/mail-insights/report${params.size ? `?${params}` : ""}`;
}
export async function fetchMailInsights(query: ReportQuery & { email?: string }): Promise<ReportResult<MailInsightsReport>> {
  const error = "Email insights are temporarily unavailable. Please retry.";
  try {
    const response = await fetch(buildMailInsightsUrl(query), { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      const instruction = failure?.error === "Choose a workspace to view email insights." ? failure.error : error;
      return { error: instruction, code: response.status === 401 || response.status === 403 ? "forbidden" : "temporarily_unavailable" };
    }
    const parsed = reportSchema.safeParse(await response.json());
    if (!parsed.success) return { error, code: "temporarily_unavailable" };
    return { data: parsed.data };
  } catch { return { error, code: "temporarily_unavailable" }; }
}
