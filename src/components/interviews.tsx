"use client";
import { useCallback, useMemo, useState } from "react";
import { PageLoading } from "./page-loading";
import { PageHeading, SelectField } from "./common";
import { getInterviewPerformance } from "@/lib/read-client";
import type { PeriodSelection } from "@/lib/calendar-period";
import type { GroupedReportQuery, InterviewReport as SeedReport } from "@/lib/report-types";
import { PeriodSelector, useCalendarDay } from "./period-selector";
import { useReport } from "./use-report";
import { readKey, type ReadSeed } from "@/lib/read-state";
import { useReadScope } from "@/lib/read-scope";
import { Button } from "./ui/button";
import { useMailReport, type MailReportContext } from "./use-mail-report";
import { invitationRate, mergeMailGroups, projectMailMetrics, unavailableMailMetric } from "@/lib/mail-metrics";
import { MailCount, MailReportNotice, ReportWorkspaceSelector } from "./mail-report-common";

export function InterviewReport({ initial, mailContext = {} }: { initial?: ReadSeed<SeedReport>; mailContext?: MailReportContext } = {}) {
  const scope = useReadScope();
  const [period, setPeriod] = useState<PeriodSelection>({ preset: "all" });
  const [group, setGroup] = useState<GroupedReportQuery["group"]>("profile");
  const [workspace, setWorkspace] = useState(mailContext.workspaceId ?? "");
  const day = useCalendarDay();
  const mailQuery = useMemo(() => ({ period, ...(workspace ? { workspace } : {}) }), [period, workspace]);
  const mail = useMailReport(mailQuery, mailContext.role === "admin");
  const mailReport = mail.error ? undefined : mail.data;
  const from = mailReport?.range.from, to = mailReport?.range.to;
  const bounded = mailReport?.status === "ready" && !mailReport.range.empty;
  const query = useMemo<GroupedReportQuery>(() => ({ period: bounded && from && to ? { preset: "custom", from, to } : period, group, ...(workspace ? { workspace } : {}) }), [bounded, from, to, period, group, workspace]);
  const request = useCallback(() => getInterviewPerformance(query), [query]);
  const { data: report, loading, error, refresh } = useReport(readKey(scope, "interviews", query, day), request, initial);
  const metrics = projectMailMetrics(mailReport, group);
  const rows = mergeMailGroups(report?.groups ?? [], metrics.groups, row => ({ id: row.id, label: row.label, applied: 0, interviews: 0, conversion: null }));
  const ratio = (metric: typeof unavailableMailMetric, applications?: number) => {
    const value = applications === undefined || error ? null : invitationRate(metric, applications);
    return value === null ? "—" : `${value.toFixed(1)}%`;
  };
  return <>
    <PageHeading eyebrow="EMAIL OUTCOMES" title="Interview performance" description="Invitation messages from Mail Check alongside applications first applied in the same available period." />
    <div className="panel mb-5 flex flex-wrap items-end gap-3 p-4">
      <PeriodSelector label="Report period" value={period} onChange={setPeriod} />
      {mailContext.role === "admin" && !mailContext.workspaceId && <ReportWorkspaceSelector value={workspace} onChange={setWorkspace} workspaces={mailContext.workspaces ?? []} />}
      <SelectField label="Group by" value={group} onChange={event => setGroup(event.target.value as typeof group)}><option value="profile">Candidate profile</option><option value="bidder">Bidder</option><option value="assignment">Profile · bidder assignment</option></SelectField>
      <Button size="sm" variant="outline" onClick={() => { refresh(); mail.refresh(); }} disabled={loading || mail.loading}>Refresh reports</Button>
    </div>
    <div className="mb-5 grid gap-4 sm:grid-cols-3">{[
      ["Applied applications", report?.totals.applied.toLocaleString() ?? "—"],
      ["Interview invitations", <MailCount key="invitations" metric={metrics.total} field="invitations" />],
      ["Invitation emails / applications", ratio(metrics.total, report?.totals.applied)],
    ].map(([label, value]) => <div className="panel p-5" key={String(label)}><p className="text-xs text-muted-foreground">{label}</p><strong className="mt-2 block text-2xl">{value}</strong></div>)}</div>
    <MailReportNotice mail={mail} />
    <p className="mb-4 text-xs text-muted-foreground">This is a period ratio, not an individual application conversion rate. Multiple invitation messages can make it exceed 100%.{bounded ? ` Applications first applied from ${from} through ${to} CT form the denominator.` : " Email metrics are unavailable; applications retain the selected period."}</p>
    {!!report?.totals.excludedApplications && <p className="mb-4 rounded-lg bg-muted p-3 text-xs text-muted-foreground">{report.totals.excludedApplications.toLocaleString()} historical applications have incomplete tracking records and are excluded from the application denominator.</p>}
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}{report ? " Showing the last successful application results for these filters." : ""} <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>Retry</Button></p>}
    <div className="panel"><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="border-b bg-muted/40 text-xs text-muted-foreground"><tr><th className="p-4">{group === "profile" ? "Candidate profile" : group === "bidder" ? "Bidder" : "Profile · bidder"}</th><th className="p-4">Applied applications</th><th className="p-4">Interview invitations</th><th className="p-4">Email / application ratio</th></tr></thead><tbody>
      {loading && !report ? null : rows.map(row => <tr key={row.id} className="border-b last:border-0"><td className="p-4 font-medium">{row.label}{metrics.groups.get(row.id)?.metric.shared && <span className="mt-1 block text-[11px] font-normal text-muted-foreground">Shared mailbox</span>}</td><td className="p-4">{row.applied}</td><td className="p-4"><MailCount metric={metrics.groups.get(row.id)?.metric} field="invitations" /></td><td className="p-4">{ratio(metrics.groups.get(row.id)?.metric ?? unavailableMailMetric, report ? row.applied : undefined)}</td></tr>)}
      {!loading && report && !rows.length && <tr><td colSpan={4} className="p-10 text-center text-muted-foreground">No applications or assigned email activity in this period.</td></tr>}
      {!loading && !report && <tr><td colSpan={4} className="p-10 text-center text-muted-foreground">Application report unavailable.</td></tr>}
    </tbody></table></div>
      {loading && !report && <PageLoading label="Loading interview report…" size="section" />}
    </div>
  </>;
}
