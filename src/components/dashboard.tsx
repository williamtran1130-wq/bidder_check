"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowUpRight, BriefcaseBusiness, CalendarCheck2, CheckCheck, LoaderCircle, Mail, RefreshCw, Wallet } from "lucide-react";
import type { DashboardData } from "@/lib/data";
import { usd } from "@/lib/domain";
import { dashboardDateLabel } from "@/lib/dashboard-report";
import { resolveCalendarPeriod, type PeriodSelection } from "@/lib/calendar-period";
import { Comparison } from "./dashboard-comparison";
import { EmailInsights } from "./email-insights";
import { PageHeading } from "./common";
import { PeriodSelector } from "./period-selector";
import { useReportBundle } from "./use-report-bundle";
import type { ReportBundle } from "@/lib/report-bundle";
import { type ReadSeed } from "@/lib/read-state";
import type { DashboardReport as SeedReport } from "@/lib/report-types";
import { Button } from "./ui/button";
import { confirmationBuckets, mergeMailGroups, projectMailMetrics } from "@/lib/mail-metrics";
import { activeBidders, activeCandidateProfiles, activeWorkspaces } from "@/lib/active-items";

const chartStyle = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 };
const tick = { fontSize: 11, fill: "var(--muted)" };
export function Dashboard({ data, initial }: { data: DashboardData; initial?: ReadSeed<ReportBundle<SeedReport>> }) {
  const [period, setPeriod] = useState<PeriodSelection>({ preset: "this_week" });
  const [workspaceSelection, setWorkspace] = useState("");
  const [bidderSelection, setBidder] = useState("");
  const [profileSelection, setProfile] = useState("");
  const [email, setEmail] = useState("");
  const isManager = data.profile.role !== "bidder";
  const workspaces = activeWorkspaces(data);
  const workspace = workspaces.some(row => row.id === workspaceSelection) ? workspaceSelection : "";
  const bidders = activeBidders(data).filter(row => !workspace || row.workspace_id === workspace);
  const candidates = activeCandidateProfiles(data).filter(row => !workspace || row.workspace_id === workspace);
  const bidder = bidders.some(row => row.user_id === bidderSelection) ? bidderSelection : "";
  const profile = candidates.some(row => row.id === profileSelection) ? profileSelection : "";
  const query = useMemo(() => ({ period, workspace: workspace || undefined, bidder: bidder || undefined, profile: profile || undefined, ...(email ? { email } : {}) }), [period, workspace, bidder, profile, email]);
  const bundle = useReportBundle("overview", query, initial);
  const { report, loading, error, refresh, mail } = bundle;
  const mailReport = mail.error ? undefined : mail.data;
  const mailBidders = projectMailMetrics(mailReport, "bidder");
  const mailProfiles = projectMailMetrics(mailReport, "profile");
  const bidderRows = mergeMailGroups(report?.comparisons.bidders ?? [], mailBidders.groups, row => ({ id: row.id, label: row.label, found: 0, foundApplied: 0 })).filter(row => bidders.some(bidder => bidder.user_id === row.id));
  const profileRows = mergeMailGroups(report?.comparisons.profiles ?? [], mailProfiles.groups, row => ({ id: row.id, label: row.label, found: 0, foundApplied: 0 })).filter(row => candidates.some(candidate => candidate.id === row.id));
  const confirmationSeries = confirmationBuckets(mailReport, report?.series ?? []);
  const range = resolveCalendarPeriod(period);
  const stats = [
    { label: "Bids found", value: report?.totals.found.toLocaleString() ?? "—", note: "Found in this period", icon: BriefcaseBusiness },
    { label: "Bids applied", value: report?.totals.appliedActivity.toLocaleString() ?? "—", note: "By latest applied date", icon: CheckCheck },
    { label: "Confirmation email", value: mailProfiles.total.confirmations?.toLocaleString() ?? "—", note: "From Mail Check", icon: Mail },
    { label: "Interview invites", value: mailProfiles.total.invitations?.toLocaleString() ?? "—", note: "From Mail Check", icon: CalendarCheck2 },
    ...(isManager ? [{ label: "Earned", value: report?.financial ? usd(report.financial.earningsCents) : "—", note: "By first applied date", icon: Wallet }] : []),
  ];
  const series = report?.series.map((row, index) => ({ ...row, ...confirmationSeries[index], label: dashboardDateLabel(row.from), tooltip: `${row.from === row.to ? dashboardDateLabel(row.from) : `${dashboardDateLabel(row.from)} – ${dashboardDateLabel(row.to)}`} CT` })) ?? [];
  return <>
    <PageHeading eyebrow="LET’S MAKE TODAY COUNT" title={`Welcome back, ${data.profile.display_name.split(" ")[0] || "there"}.`} description="Your team's application activity at a glance.">
      <Button size="sm" variant="outline" onClick={refresh} disabled={loading || mail.loading} aria-label="Refresh dashboard">{loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />} Refresh</Button>
      <Button size="sm" asChild><Link href="/bids">Bid workspace <ArrowUpRight size={14} /></Link></Button>
    </PageHeading>
    <section className="panel mb-5 flex flex-wrap items-end gap-3 p-4" aria-label="Dashboard report filters">
      <PeriodSelector value={period} onChange={setPeriod} />
      {isManager && (data.profile.role === "admin" || workspaces.length > 1) && <label className="space-y-1 text-xs text-muted-foreground"><span>Workspace</span><select className="native-select block text-foreground" value={workspace} onChange={(event) => { setWorkspace(event.target.value); setBidder(""); setProfile(""); setEmail(""); }}><option value="">All workspaces</option>{workspaces.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
      {isManager && <label className="space-y-1 text-xs text-muted-foreground"><span>Bidder</span><select className="native-select block text-foreground" value={bidder} onChange={(event) => { setBidder(event.target.value); setEmail(""); }}><option value="">All bidders</option>{bidders.map((row) => <option key={row.user_id} value={row.user_id}>{data.profiles.find((person) => person.id === row.user_id)?.display_name ?? "Bidder"}</option>)}</select></label>}
      <label className="space-y-1 text-xs text-muted-foreground"><span>Candidate profile</span><select className="native-select block text-foreground" value={profile} onChange={(event) => { setProfile(event.target.value); setEmail(""); }}><option value="">All profiles</option>{candidates.map((row) => <option key={row.id} value={row.id}>{row.identifier}</option>)}</select></label>
      <span className="ml-auto pb-2 text-xs text-muted-foreground" role="status">{range.from ? `${range.from} – ${range.to} CT` : "All time · CT"}</span>
    </section>
    {error && <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3 text-sm" role="alert" aria-label="Bid reporting error"><span>{error}{report ? " Showing the last successful results for these filters." : ""}</span><Button variant="outline" size="sm" onClick={refresh} disabled={loading}>Retry</Button></div>}
    <section aria-label="Dashboard summary" className={`mb-5 grid gap-3 sm:grid-cols-2 ${isManager ? "xl:grid-cols-5" : "xl:grid-cols-4"}`}>
      {stats.map((stat) => <div role="group" aria-label={stat.label} className="panel p-4" key={stat.label}><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-muted-foreground">{stat.label}</span><stat.icon size={16} className="shrink-0 text-primary" /></div><p className="mt-3 text-2xl font-semibold tracking-tight">{loading && !report ? <span className="inline-block h-7 w-20 animate-pulse rounded bg-muted" /> : stat.value}</p><p className="mt-1.5 text-[11px] text-muted-foreground">{stat.note}</p></div>)}
    </section>
    <section className="panel mb-5 min-w-0 p-5" aria-label="Application activity">
      <h2 className="font-semibold">Application activity</h2><p className="mt-1 text-xs text-muted-foreground">Bids found and latest application activity by {report?.range.bucketUnit ?? "day"}, in CT.</p>
      <div className="mt-5 h-64 min-w-0" role="img" aria-label={report ? `Activity chart: ${report.totals.found} found, ${report.totals.appliedActivity} applications, ${mailProfiles.total.confirmations ?? "unavailable"} confirmation emails, ${mailProfiles.total.invitations ?? "unavailable"} interview invites.` : "Activity chart loading or unavailable"}>
        {loading && !report ? <div className="h-full animate-pulse rounded bg-muted/50" /> : !report ? <p className="py-20 text-center text-sm text-muted-foreground">Activity unavailable.</p> : <ResponsiveContainer width="100%" height="100%"><AreaChart data={series} margin={{ top: 8, right: 8, left: -15, bottom: 0 }}><CartesianGrid strokeDasharray="3 5" vertical={false} stroke="var(--border)" /><XAxis dataKey="label" minTickGap={32} tick={tick} axisLine={false} tickLine={false} /><YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(_, payload) => payload?.[0]?.payload?.tooltip ?? ""} contentStyle={chartStyle} /><Area name="Found" dataKey="found" type="monotone" stroke="#8576ed" strokeWidth={2} fill="#8576ed" fillOpacity={0.12} isAnimationActive={false} /><Area name="Applied activity" dataKey="applied" type="monotone" stroke="#34b991" strokeWidth={2} fill="transparent" isAnimationActive={false} /><Area name="Interview invites" dataKey="invitations" dot={{ r: 3 }} type="monotone" stroke="var(--category-interview_invite-fill)" strokeWidth={2} fill="transparent" connectNulls={false} isAnimationActive={false} /><Area name="Confirmation emails" dataKey="confirmations" dot={{ r: 3 }} type="monotone" stroke="var(--category-application_ack-fill)" strokeDasharray="6 4" strokeWidth={2} fill="transparent" connectNulls={false} isAnimationActive={false} /></AreaChart></ResponsiveContainer>}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-muted-foreground"><span>● Found</span><span className="text-emerald-700 dark:text-emerald-400">● Applied activity</span><span className="text-primary">┄ Confirmation emails</span><span className="text-primary">● Interview invites</span></div>
      {!!report && <details className="mt-4 border-t pt-3 text-xs"><summary className="cursor-pointer font-medium">View activity values</summary><div className="mt-3 max-h-60 overflow-auto"><table className="w-full text-right"><caption className="sr-only">Activity values in Central Time</caption><thead><tr><th className="py-2 text-left">Period</th><th>Found</th><th>Applied from cohort</th><th>Applied activity</th><th>Confirmation emails</th><th>Interview invites</th></tr></thead><tbody>{series.map((row) => <tr key={row.from} className="border-t"><th className="py-2 text-left font-medium" scope="row">{row.tooltip}</th><td>{row.found}</td><td>{row.foundApplied}</td><td>{row.applied}</td><td>{row.confirmations ?? "—"}</td><td>{row.invitations ?? "—"}</td></tr>)}</tbody></table></div></details>}
    </section>
    <div className={`mb-5 grid gap-5 ${isManager ? "xl:grid-cols-2" : ""}`}>
      {isManager && <Comparison title="By bidder" rows={bidderRows} mailGroups={mailBidders.groups} loading={loading} available={!!report} />}
      <Comparison title="By profile" rows={profileRows} mailGroups={mailProfiles.groups} loading={loading} available={!!report} />
    </div>
    <EmailInsights mail={mail} workspace={workspace} isManager={isManager} email={email} onEmailChange={setEmail} />
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground"><p className="mr-auto">Historical totals include retained application summaries.</p>{isManager && <><Link className="font-medium text-primary" href="/bids?review=pending">Open review queue <ArrowUpRight className="inline" size={12} /></Link><Link className="font-medium text-primary" href="/earnings">View earnings <ArrowUpRight className="inline" size={12} /></Link></>}</div>
  </>;
}
