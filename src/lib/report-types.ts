import type { PeriodSelection } from "./calendar-period";

export type ReportQuery = { period: PeriodSelection; workspace?: string; bidder?: string; profile?: string; email?: string };
export type GroupedReportQuery = ReportQuery & { group: "profile" | "bidder" | "assignment" };
export type ReportResult<T> = { data?: T; error?: string; code?: "temporarily_unavailable" | "unavailable" | "validation" | "forbidden" };
export type ArrangementCounts = { found: number; foundApplied: number };
export type ComparisonRow = {
  id: string; label: string; found: number; foundApplied: number;
  arrangements?: { remote: ArrangementCounts; onsiteHybrid: ArrangementCounts; unspecified: ArrangementCounts };
};
export type DashboardReport = {
  range: { from: string; to: string; bucketUnit: "day" | "week" | "month" | "year"; bucketSize: number };
  totals: { found: number; foundApplied: number; appliedActivity: number; trackedApplications: number; trackedInterviews: number };
  series: { from: string; to: string; found: number; foundApplied: number; applied: number }[];
  comparisons: { bidders: ComparisonRow[]; profiles: ComparisonRow[] };
  financial?: { earningsCents: number; earningsCount: number };
};
export type EarningsReport = {
  totals: { count: number; cents: number; resumes: number; retainedCount: number; trackedApplications: number; trackedInterviews: number; excludedInterviewCount: number };
  groups: { id: string; label: string; sub: string; count: number; cents: number; applied: number; interviews: number }[];
};
export type InterviewReport = {
  totals: { applied: number; interviews: number; excludedApplications: number };
  groups: { id: string; label: string; applied: number; interviews: number; conversion: number | null }[];
};
