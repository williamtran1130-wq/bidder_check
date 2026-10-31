import { aggregateMailInsights, type MailGroup, type MailInsightsReport } from "./mail-insights-report";
import { formatInTimeZone } from "date-fns-tz";

export type MailMetricStatus = "ready" | "partial" | "not_synced" | "outside_retention" | "unavailable";
export type MailMetric = { confirmations: number | null; invitations: number | null; status: MailMetricStatus; shared?: boolean };
export type MailMetricGroup = { id: string; label: string; metric: MailMetric };
export const unavailableMailMetric: MailMetric = { confirmations: null, invitations: null, status: "unavailable" };
const normalize = (email: string) => email.trim().toLowerCase();

/** Current-assignment attribution, never individual application/message matching. */
export function projectMailMetrics(report: MailInsightsReport | undefined, group: Exclude<MailGroup, "email">) {
  const groups = new Map<string, MailMetricGroup>();
  if (!report) return { total: unavailableMailMetric, groups, daily: [] as { date: string; metric: MailMetric }[] };
  const aggregated = aggregateMailInsights(report, {}, group, false);
  const mailboxes = new Map(report.mailboxes.map(row => [normalize(row.email), row]));
  const assignedEmails = [...new Set(report.assignments.map(row => normalize(row.email)))];
  const status = (emails: string[], from: string, to: string): MailMetricStatus => {
    if (report.range.empty || to < report.range.from || from > report.range.to) return "outside_retention";
    if (report.status !== "ready" || !emails.some(email => mailboxes.has(email))) return "not_synced";
    if (from < report.range.from || to > report.range.to || emails.some(email => {
      const mailbox = mailboxes.get(email);
      const collected = mailbox?.collected_at;
      return !collected || !Number.isFinite(Date.parse(collected)) || !mailbox?.coverage_start || mailbox.coverage_start > from ||
        formatInTimeZone(collected, "America/Chicago", "yyyy-MM-dd") < to;
    })) return "partial";
    return "ready";
  };
  const metric = (emails: string[], confirmations: number, invitations: number, from = report.range.from, to = report.range.to): MailMetric => {
    const state = status(emails, from, to);
    const available = state === "ready" || state === "partial";
    return { confirmations: available ? confirmations : null, invitations: available ? invitations : null, status: state };
  };
  for (const row of aggregated.groups) groups.set(row.id, { id: row.id, label: row.label, metric: { ...metric(row.emails, row.categories?.application_ack ?? 0, row.categories?.interview_invite ?? 0), shared: row.shared } });
  return {
    total: metric(assignedEmails, aggregated.categories.application_ack, aggregated.categories.interview_invite), groups,
    daily: aggregated.daily.map(row => ({ date: row.date, metric: metric(assignedEmails, row.application_ack, row.interview_invite, row.date, row.date) })),
  };
}

export function confirmationBuckets(report: MailInsightsReport | undefined, buckets: { from: string; to: string }[]) {
  const { daily } = projectMailMetrics(report, "profile");
  return buckets.map(bucket => {
    const days = daily.filter(day => day.date >= bucket.from && day.date <= bucket.to);
    const available = days.filter(day => day.metric.confirmations !== null);
    const status: MailMetricStatus = !report ? "unavailable" : !days.length ? "outside_retention" : !available.length ? days[0].metric.status :
      bucket.from < report.range.from || bucket.to > report.range.to || days.some(day => day.metric.status !== "ready") ? "partial" : "ready";
    return {
      confirmations: available.length ? available.reduce((sum, day) => sum + day.metric.confirmations!, 0) : null,
      invitations: available.length ? available.reduce((sum, day) => sum + (day.metric.invitations ?? 0), 0) : null,
      status,
    };
  });
}

export function invitationRate(metric: MailMetric, applications: number): number | null {
  return metric.status === "ready" && metric.invitations !== null && applications > 0 ? metric.invitations / applications * 100 : null;
}

export function mergeMailGroups<T extends { id: string; label: string }>(rows: T[], groups: Map<string, MailMetricGroup>, empty: (group: MailMetricGroup) => T): T[] {
  const merged = new Map(rows.map(row => [row.id, row]));
  for (const group of groups.values()) if (!merged.has(group.id) && (group.metric.confirmations !== null || group.metric.invitations !== null)) merged.set(group.id, empty(group));
  return [...merged.values()];
}
