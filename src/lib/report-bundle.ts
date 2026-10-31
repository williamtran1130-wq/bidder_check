import type { DashboardReport, EarningsReport, InterviewReport, ReportQuery, GroupedReportQuery, ReportResult } from "./report-types";
import type { MailInsightsReport } from "./mail-insights-report";
import { resolveCalendarPeriod } from "./calendar-period";
import { browserReports } from "./report-cache";

export type ReportKind = "overview" | "interviews" | "earnings";
export type CollectionStatus = { status: "ready" | "not_synced"; updatedAt: string | null; from: string | null; to: string | null };
export type InterviewValue = { invitations: number | null; applications: number | null; rate: number | null };
export type ReportBundle<T> = {
  report: T;
  mail: MailInsightsReport | null;
  collection: CollectionStatus;
  interviewPeriod: { from: string; to: string } | null;
  interview: InterviewValue & { groups: Record<string, InterviewValue> };
};
export type KindReport = { overview: DashboardReport; interviews: InterviewReport; earnings: EarningsReport };
export function bundleUrl(kind: ReportKind, query: ReportQuery | GroupedReportQuery) {
  const dates = resolveCalendarPeriod(query.period);
  const values = { ...dates, workspace: query.workspace, bidder: query.bidder, profile: query.profile, email: query.email, group: "group" in query ? query.group : undefined };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  return `/api/reports/${kind}${params.size ? `?${params}` : ""}`;
}
export async function fetchReportBundle<K extends ReportKind>(kind: K, query: ReportQuery | GroupedReportQuery): Promise<ReportResult<ReportBundle<KindReport[K]>>> {
  try {
    const response = await fetch(bundleUrl(kind, query), { credentials: "same-origin", cache: "no-store" });
    const body = await response.json();
    if (!response.ok) {
      if ((response.status === 401 || response.status === 403) && typeof window !== "undefined") {
        browserReports.clear();
        window.dispatchEvent(new Event("workspace-access-revoked"));
        window.location.assign(["/auth/login", "/auth/approval", "/auth/inactive"].includes(body.destination) ? body.destination : response.status === 401 ? "/auth/login" : "/dashboard");
      }
      return { error: body.error || "Report unavailable. Please retry.", code: response.status === 401 || response.status === 403 ? "forbidden" : "temporarily_unavailable" };
    }
    if (!body?.report || !body?.collection || !body?.interview) return { error: "Report unavailable. Please retry.", code: "unavailable" };
    return { data: body };
  } catch { return { error: "Report unavailable. Please retry.", code: "temporarily_unavailable" }; }
}
