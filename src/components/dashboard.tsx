"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowUpRight, BriefcaseBusiness, CalendarCheck2, CheckCheck, LoaderCircle, RefreshCw, Target, Wallet } from "lucide-react";
import type { DashboardData } from "@/lib/data";
import { usd } from "@/lib/domain";
import { applicationRate, dashboardDateLabel } from "@/lib/dashboard-report";
import { resolveCalendarPeriod, type PeriodSelection } from "@/lib/calendar-period";
import { Comparison } from "./dashboard-comparison";
import { getDashboardPerformance } from "@/lib/read-client";
import { PageHeading } from "./common";
import { PeriodSelector, useCalendarDay } from "./period-selector";
import { useReport } from "./use-report";
import { readKey, type ReadSeed } from "@/lib/read-state";
import type { DashboardReport as SeedReport } from "@/lib/report-types";
import { useReadScope } from "@/lib/read-scope";
import { Button } from "./ui/button";

const chartStyle = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 };
const tick = { fontSize: 11, fill: "var(--muted)" };
export function Dashboard({ data, initial }: { data: DashboardData; initial?: ReadSeed<SeedReport> }) {
  const scope = useReadScope();
  const [period, setPeriod] = useState<PeriodSelection>({ preset: "this_week" });
  const [workspace, setWorkspace] = useState("");
  const [bidder, setBidder] = useState("");
  const [profile, setProfile] = useState("");
  const day = useCalendarDay();
  const isManager = data.profile.role !== "bidder";
  const request = useCallback(() => getDashboardPerformance({ period, workspace: workspace || undefined, bidder: bidder || undefined, profile: profile || undefined }), [period, workspace, bidder, profile]);
  const queryKey = readKey(scope, "dashboard", { period, workspace: workspace || undefined, bidder: bidder || undefined, profile: profile || undefined }, day);
  const { data: report, loading, error, refresh } = useReport(queryKey, request, initial);
  const range = resolveCalendarPeriod(period);
  const rate = report ? applicationRate(report.totals.found, report.totals.foundApplied) : null;
  const interviewRate = report && report.totals.trackedApplications ? report.totals.trackedInterviews / report.totals.trackedApplications * 100 : null;
  const stats = [
    { label: "Bids found", value: report?.totals.found.toLocaleString() ?? "—", note: "Found in this period", icon: BriefcaseBusiness },
    { label: "Applied from cohort", value: report?.totals.foundApplied.toLocaleString() ?? "—", note: rate === null ? "Of bids found in this period" : `${rate.toFixed(1)}% of bids found`, icon: CheckCheck },
    { label: "Application activity", value: report?.totals.appliedActivity.toLocaleString() ?? "—", note: "By latest applied date", icon: Target },
    { label: "Interview conversion", value: interviewRate === null ? "—" : `${interviewRate.toFixed(1)}%`, note: report ? `${report.totals.trackedInterviews} invitations / ${report.totals.trackedApplications} tracked applications` : "By first applied date", icon: CalendarCheck2 },
    ...(isManager ? [{ label: "Earned", value: report?.financial ? usd(report.financial.earningsCents) : "—", note: "By first applied date", icon: Wallet }] : []),
  ];
  const series = report?.series.map((row) => ({ ...row, label: dashboardDateLabel(row.from), tooltip: row.from === row.to ? `${dashboardDateLabel(row.from)} CT` : `${dashboardDateLabel(row.from)} – ${dashboardDateLabel(row.to)} CT` })) ?? [];
  return <>
    <PageHeading eyebrow="LET’S MAKE TODAY COUNT" title={`Welcome back, ${data.profile.display_name.split(" ")[0] || "there"}.`} description="Your team's application activity at a glance.">
      <Button size="sm" variant="outline" onClick={refresh} disabled={loading} aria-label="Refresh dashboard">{loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />} Refresh</Button>
      <Button size="sm" asChild><Link href="/bids">Bid workspace <ArrowUpRight size={14} /></Link></Button>
    </PageHeading>
    <section className="panel mb-5 flex flex-wrap items-end gap-3 p-4" aria-label="Dashboard report filters">
      <PeriodSelector value={period} onChange={setPeriod} />
      {isManager && (data.profile.role === "admin" || data.workspaces.length > 1) && <label className="space-y-1 text-xs text-muted-foreground"><span>Workspace</span><select className="native-select block text-foreground" value={workspace} onChange={(event) => { setWorkspace(event.target.value); setBidder(""); setProfile(""); }}><option value="">All workspaces</option>{data.workspaces.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
      {isManager && <label className="space-y-1 text-xs text-muted-foreground"><span>Bidder</span><select className="native-select block text-foreground" value={bidder} onChange={(event) => setBidder(event.target.value)}><option value="">All bidders</option>{data.bidders.filter((row) => !row.archived && (!workspace || row.workspace_id === workspace)).map((row) => <option key={row.user_id} value={row.user_id}>{data.profiles.find((person) => person.id === row.user_id)?.display_name ?? "Bidder"}</option>)}</select></label>}
      <label className="space-y-1 text-xs text-muted-foreground"><span>Candidate profile</span><select className="native-select block text-foreground" value={profile} onChange={(event) => setProfile(event.target.value)}><option value="">All profiles</option>{data.candidateProfiles.filter((row) => !row.archived && (!workspace || row.workspace_id === workspace)).map((row) => <option key={row.id} value={row.id}>{row.identifier}</option>)}</select></label>
      <span className="ml-auto pb-2 text-xs text-muted-foreground" role="status">{range.from ? `${range.from} – ${range.to} CT` : "All time · CT"}</span>
    </section>
    {error && <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3 text-sm" role="alert"><span>{error}{report ? " Showing the last successful results for these filters." : ""}</span><Button variant="outline" size="sm" onClick={refresh} disabled={loading}>Retry</Button></div>}
    <div className={`mb-5 grid gap-3 sm:grid-cols-2 ${isManager ? "xl:grid-cols-5" : "xl:grid-cols-4"}`}>
      {stats.map((stat) => <div className="panel p-4" key={stat.label}><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-muted-foreground">{stat.label}</span><stat.icon size={16} className="shrink-0 text-primary" /></div><p className="mt-3 text-2xl font-semibold tracking-tight">{loading && !report ? <span className="inline-block h-7 w-20 animate-pulse rounded bg-muted" /> : stat.value}</p><p className="mt-1.5 text-[11px] text-muted-foreground">{stat.note}</p></div>)}
    </div>
    <section className="panel mb-5 min-w-0 p-5" aria-label="Application activity">
      <h2 className="font-semibold">Application activity</h2><p className="mt-1 text-xs text-muted-foreground">Bids found and latest application activity by {report?.range.bucketUnit ?? "day"}, in CT.</p>
      <div className="mt-5 h-64 min-w-0" role="img" aria-label={report ? `Activity chart: ${report.totals.found} found, ${report.totals.appliedActivity} applications.` : "Activity chart loading or unavailable"}>
        {loading && !report ? <div className="h-full animate-pulse rounded bg-muted/50" /> : !report ? <p className="py-20 text-center text-sm text-muted-foreground">Activity unavailable.</p> : <ResponsiveContainer width="100%" height="100%"><AreaChart data={series} margin={{ top: 8, right: 8, left: -15, bottom: 0 }}><CartesianGrid strokeDasharray="3 5" vertical={false} stroke="var(--border)" /><XAxis dataKey="label" minTickGap={32} tick={tick} axisLine={false} tickLine={false} /><YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(_, payload) => payload?.[0]?.payload?.tooltip ?? ""} contentStyle={chartStyle} /><Area name="Found" dataKey="found" type="monotone" stroke="#8576ed" strokeWidth={2} fill="#8576ed" fillOpacity={0.12} isAnimationActive={false} /><Area name="Applied activity" dataKey="applied" type="monotone" stroke="#34b991" strokeWidth={2} fill="transparent" isAnimationActive={false} /></AreaChart></ResponsiveContainer>}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-muted-foreground"><span>● Found</span><span className="text-emerald-700 dark:text-emerald-400">● Applied activity</span></div>
      {!!report && <details className="mt-4 border-t pt-3 text-xs"><summary className="cursor-pointer font-medium">View activity values</summary><div className="mt-3 max-h-60 overflow-auto"><table className="w-full text-right"><caption className="sr-only">Activity values in Central Time</caption><thead><tr><th className="py-2 text-left">Period</th><th>Found</th><th>Applied from cohort</th><th>Applied activity</th></tr></thead><tbody>{series.map((row) => <tr key={row.from} className="border-t"><th className="py-2 text-left font-medium" scope="row">{row.tooltip}</th><td>{row.found}</td><td>{row.foundApplied}</td><td>{row.applied}</td></tr>)}</tbody></table></div></details>}
    </section>
    <div className={`mb-5 grid gap-5 ${isManager ? "xl:grid-cols-2" : ""}`}>
      {isManager && <Comparison title="By bidder" rows={report?.comparisons.bidders ?? []} loading={loading} available={!!report} />}
      <Comparison title="By profile" rows={report?.comparisons.profiles ?? []} loading={loading} available={!!report} />
    </div>
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground"><p className="mr-auto">Historical totals include retained application summaries.</p>{isManager && <><Link className="font-medium text-primary" href="/bids?review=pending">Open review queue <ArrowUpRight className="inline" size={12} /></Link><Link className="font-medium text-primary" href="/earnings">View earnings <ArrowUpRight className="inline" size={12} /></Link></>}</div>
  </>;
}
