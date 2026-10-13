"use client";
import { PageLoading } from "./page-loading";
import { useCallback, useState } from "react";
import { PageHeading, SelectField } from "./common";
import { getInterviewPerformance } from "@/lib/read-client";
import type { PeriodSelection } from "@/lib/calendar-period";
import type { GroupedReportQuery } from "@/lib/report-types";
import { PeriodSelector, useCalendarDay } from "./period-selector";
import { useReport } from "./use-report";
import { readKey, type ReadSeed } from "@/lib/read-state";
import type { InterviewReport as SeedReport } from "@/lib/report-types";
import { useReadScope } from "@/lib/read-scope";
import { Button } from "./ui/button";

export function InterviewReport({ initial }: { initial?: ReadSeed<SeedReport> } = {}) {
  const scope = useReadScope();
  const [period, setPeriod] = useState<PeriodSelection>({ preset: "all" });
  const [group, setGroup] = useState<GroupedReportQuery["group"]>("profile");
  const day = useCalendarDay();
  const request = useCallback(() => getInterviewPerformance({ period, group }), [period, group]);
  const { data: report, loading, error, refresh } = useReport(readKey(scope, "interviews", { period, group }, day), request, initial);
  const totals = report?.totals;
  const rows = report?.groups ?? [];
  const conversion = totals?.applied ? `${(totals.interviews / totals.applied * 100).toFixed(1)}%` : "—";
  return <>
    <PageHeading eyebrow="CONVERSION OUTCOMES" title="Interview performance" description="Interview invitations from applications first applied in the selected period." />
    <div className="panel mb-5 flex flex-wrap items-end gap-3 p-4">
      <PeriodSelector label="Cohort period" value={period} onChange={setPeriod} />
      <SelectField label="Group by" value={group} onChange={(event) => setGroup(event.target.value as typeof group)}><option value="profile">Candidate profile</option><option value="bidder">Bidder</option><option value="assignment">Profile · bidder assignment</option></SelectField>
    </div>
    <div className="mb-5 grid gap-4 sm:grid-cols-3">{[
      ["Applied applications", totals?.applied.toLocaleString() ?? "—"],
      ["Interview invitations", totals?.interviews.toLocaleString() ?? "—"],
      ["Interview conversion", conversion],
    ].map(([label, value]) => <div className="panel p-5" key={label}><p className="text-xs text-muted-foreground">{label}</p><strong className="mt-2 block text-2xl">{value}</strong></div>)}</div>
    {!!totals?.excludedApplications && <p className="mb-4 rounded-lg bg-muted p-3 text-xs text-muted-foreground">{totals.excludedApplications.toLocaleString()} historical applications have no recoverable interview status and are excluded from this ratio.</p>}
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}{report ? " Showing the last successful results for these filters." : ""} <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>Retry</Button></p>}
    <div className="panel"><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="border-b bg-muted/40 text-xs text-muted-foreground"><tr><th className="p-4">{group === "profile" ? "Candidate profile" : group === "bidder" ? "Bidder" : "Profile · bidder"}</th><th className="p-4">Applied applications</th><th className="p-4">Interview invitations</th><th className="p-4">Conversion</th></tr></thead><tbody>
      {loading && !report ? null : rows.map((row) => <tr key={row.id} className="border-b last:border-0"><td className="p-4 font-medium">{row.label}</td><td className="p-4">{row.applied}</td><td className="p-4">{row.interviews}</td><td className="p-4">{row.conversion === null ? "—" : `${row.conversion.toFixed(1)}%`}</td></tr>)}
      {!loading && report && !rows.length && <tr><td colSpan={4} className="p-10 text-center text-muted-foreground">No applied applications in this period.</td></tr>}
      {!loading && !report && <tr><td colSpan={4} className="p-10 text-center text-muted-foreground">Interview report unavailable.</td></tr>}
    </tbody></table></div>
      {loading && !report && <PageLoading label="Loading interview report…" size="section" />}
    </div>
  </>;
}
