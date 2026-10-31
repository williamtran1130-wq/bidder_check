"use client";
import { useCallback, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatInTimeZone } from "date-fns-tz";
import { aggregateMailInsights, fetchMailInsights, MAIL_CATEGORIES, type MailFilters, type MailGroup, type MailInsightsReport } from "@/lib/mail-insights-report";
import type { ReportQuery } from "@/lib/report-types";
import { dashboardDateLabel } from "@/lib/dashboard-report";
import { readKey } from "@/lib/read-state";
import { useReadScope } from "@/lib/read-scope";
import { useCalendarDay } from "./period-selector";
import { useReport } from "./use-report";
import { Button } from "./ui/button";

type ViewProps = {
  report?: MailInsightsReport; loading: boolean; error?: string; isManager: boolean;
  email: string; onEmailChange: (email: string) => void;
  filters: MailFilters; onFiltersChange: (filters: MailFilters) => void;
  group: MailGroup; onGroupChange: (group: MailGroup) => void; onRefresh: () => void;
};
const tableCategories = ["application_ack", "interview_invite", "assessment", "offer", "rejection"] as const;
function freshness(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unknown";
  return `${formatInTimeZone(value, "America/Chicago", "MMM d, yyyy h:mm a")} CT`;
}
export function EmailInsights({ query, isManager, email, onEmailChange }: { query: ReportQuery & { email?: string }; isManager: boolean; email: string; onEmailChange: (email: string) => void }) {
  const scope = useReadScope();
  const day = useCalendarDay();
  const [filters, setFilters] = useState<MailFilters>({});
  const [group, setGroup] = useState<MailGroup>("email");
  const request = useCallback(() => fetchMailInsights(query), [query]);
  const key = readKey(scope, "mail-insights", query, day);
  const result = useReport(key, request);
  return <EmailInsightsView report={result.data} loading={result.loading} error={result.error} isManager={isManager} email={email} onEmailChange={onEmailChange} filters={filters} onFiltersChange={setFilters} group={isManager ? group : group === "bidder" ? "email" : group} onGroupChange={setGroup} onRefresh={result.refresh} />;
}
export function EmailInsightsView({ report, loading, error, isManager, email, onEmailChange, filters, onFiltersChange, group, onGroupChange, onRefresh }: ViewProps) {
  const result = report ? aggregateMailInsights(report, filters, group, isManager) : undefined;
  const mailAvailable = !!report?.mailboxes.length && !report.range.empty;
  const emailOptions = [...new Set([...(report?.assignments.map(row => row.email) ?? []), ...(isManager ? report?.mailboxes.map(row => row.email) ?? [] : []), ...(email ? [email] : [])])].sort();
  const stats = [
    { label: "Messages collected", value: result?.summary.total, note: "In this period" },
    { label: "Need your attention", value: result?.summary.pendingAttention, note: "Pending action, reply and unclassified categories" },
    { label: "Completed", value: result?.summary.completed, note: "Marked done in Mail Check" },
    { label: "Unclassified", value: result?.summary.unclassified, note: `${result?.summary.retryable ?? 0} can be retried in Mail Check` },
  ];
  return <section className="mb-5 min-w-0 space-y-5" aria-label="Email insights">
    <div className="flex flex-wrap items-center gap-3"><div className="mr-auto"><h2 className="font-semibold">Email insights</h2><p className="mt-1 text-xs text-muted-foreground">Mailbox activity by current assignment, in CT.</p></div><Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>{error ? "Retry email insights" : "Refresh email insights"}</Button></div>
    {error && <p className="rounded-lg border px-4 py-3 text-sm" role="alert">{error}{report ? " Showing the last successful email results for these filters." : ""}</p>}
    {report?.status === "not_synced" && <p className="rounded-lg border px-4 py-3 text-sm" role="status">Not synced. Connect Mail Check to publish mailbox metrics. Bid activity remains available below.</p>}
    {report?.range.empty && <p className="rounded-lg border px-4 py-3 text-sm" role="status">No retained email data overlaps this period. Choose a date within the latest 90 CT days.</p>}
    {report?.range.clipped && <p className="rounded-lg border px-4 py-3 text-sm" role="status">Email insights are limited to the latest 90 CT days. This section shows {report.range.from} to {report.range.to}; the main bid report keeps your selected period.</p>}
    <div className="panel flex flex-wrap items-end gap-3 p-4" aria-label="Email insight filters">
      <label className="space-y-1 text-xs text-muted-foreground"><span>Mailbox (also filters bids)</span><select className="native-select block text-foreground" value={email} onChange={event => onEmailChange(event.target.value)}><option value="">All mailboxes</option>{emailOptions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="space-y-1 text-xs text-muted-foreground"><span>Mail category</span><select className="native-select block text-foreground" value={filters.categories?.[0] ?? ""} onChange={event => onFiltersChange({ ...filters, categories: event.target.value ? [event.target.value] : [] })}><option value="">All categories</option>{MAIL_CATEGORIES.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label>
      <label className="space-y-1 text-xs text-muted-foreground"><span>Mail status</span><select className="native-select block text-foreground" value={filters.status ?? "all"} onChange={event => onFiltersChange({ ...filters, status: event.target.value as MailFilters["status"] })}><option value="all">All statuses</option><option value="pending">Pending</option><option value="done">Completed</option></select></label>
      <label className="space-y-1 text-xs text-muted-foreground"><span>Action required</span><select className="native-select block text-foreground" value={filters.action ?? "all"} onChange={event => onFiltersChange({ ...filters, action: event.target.value as MailFilters["action"] })}><option value="all">All messages</option><option value="yes">Yes</option><option value="no">No</option></select></label>
      <p className="w-full text-[11px] text-muted-foreground">Category, status and action filters affect mail counts only.</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{stats.map(stat => <div className="panel p-4" key={stat.label}><p className="text-xs font-medium text-muted-foreground">{stat.label}</p><p className="mt-3 text-2xl font-semibold tabular-nums">{loading && !report ? "Loading…" : mailAvailable ? stat.value?.toLocaleString() : "—"}</p><p className="mt-1.5 text-[11px] text-muted-foreground">{stat.note}</p></div>)}</div>
    <div className="panel min-w-0 p-5"><h3 className="font-semibold">Email categories</h3><p className="mt-1 text-xs text-muted-foreground">Unique mailbox totals; shared mailboxes count once.</p>
      <div className="mt-5 h-64 min-w-0" role="img" aria-label={mailAvailable ? `Email category chart: ${result?.summary.total} messages.` : "Email category chart unavailable until mail is synced"}>
        {!report ? <p className="py-20 text-center text-sm text-muted-foreground">{loading ? "Loading email metrics…" : "Email metrics unavailable."}</p> : !mailAvailable ? <p className="py-20 text-center text-sm text-muted-foreground">Not synced</p> : <ResponsiveContainer width="100%" height="100%"><BarChart data={result?.daily} margin={{ top: 8, right: 8, left: -15, bottom: 0 }}><CartesianGrid strokeDasharray="3 5" vertical={false} stroke="var(--border)" /><XAxis dataKey="date" tickFormatter={value => dashboardDateLabel(value)} minTickGap={40} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} /><YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={value => `${value} CT`} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 }} />{MAIL_CATEGORIES.map(category => <Bar key={category.id} dataKey={category.id} name={category.label} stackId="mail" fill={category.color} isAnimationActive={false} />)}</BarChart></ResponsiveContainer>}
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="All email category totals">{MAIL_CATEGORIES.map(category => <div key={category.id} className="flex items-center gap-2 text-xs"><span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: category.color }} /><dt className="mr-auto text-muted-foreground">{category.label}</dt><dd className="font-semibold tabular-nums">{mailAvailable ? result?.categories[category.id].toLocaleString() : "—"}</dd></div>)}</dl>
      {mailAvailable && <details className="mt-4 border-t pt-3 text-xs"><summary className="cursor-pointer font-medium">View daily email values</summary><div className="mt-3 max-h-60 overflow-auto" tabIndex={0}><table className="w-full text-right"><caption className="sr-only">Email category values by Central Time date</caption><thead><tr><th className="py-2 text-left">Date (CT)</th>{MAIL_CATEGORIES.map(category => <th className="px-2" key={category.id}>{category.label}</th>)}</tr></thead><tbody>{result?.daily.map(row => <tr className="border-t" key={row.date}><th className="py-2 text-left font-medium" scope="row">{row.date}</th>{MAIL_CATEGORIES.map(category => <td className="px-2" key={category.id}>{row[category.id]}</td>)}</tr>)}</tbody></table></div></details>}
    </div>
    <div className="panel min-w-0 p-5"><h3 className="font-semibold">Bids and email activity</h3><p className="mt-1 text-xs text-muted-foreground">Current assignments group activity by mailbox. Shared mail counts appear once per group and once in the unique totals.</p>
      <div className="mt-4 flex gap-2" role="tablist" aria-label="Group bids and email activity">{(["email", "profile", ...(isManager ? ["bidder"] : [])] as MailGroup[]).map(value => <button key={value} className={`rounded-md border px-3 py-1.5 text-xs font-medium ${group === value ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`} onClick={() => onGroupChange(value)} type="button" role="tab" aria-selected={group === value}>{value === "email" ? "Email" : value === "profile" ? "Profile" : "Bidder"}</button>)}</div>
      <div className="mt-4 overflow-x-auto" tabIndex={0} role="tabpanel" aria-label={`Activity by ${group}`}><table className="w-full whitespace-nowrap text-right text-xs"><caption className="sr-only">Bid and email activity by current assignment for {report ? `${report.range.from} through ${report.range.to} CT` : "the selected period"}</caption><thead><tr className="border-b"><th className="py-3 pr-4 text-left">{group === "email" ? "Email" : group === "profile" ? "Profile" : "Bidder"}</th><th className="px-3">Found</th><th className="px-3">Applied activity</th>{tableCategories.map(id => <th key={id} className="px-3">{id === "application_ack" ? "Confirmations" : MAIL_CATEGORIES.find(category => category.id === id)?.label}</th>)}</tr></thead><tbody>{result?.groups.map(row => <tr key={row.id} className="border-b align-top"><th scope="row" className="min-w-56 max-w-80 whitespace-normal py-3 pr-4 text-left font-medium">{group === "email" ? <button type="button" className="break-all text-primary hover:underline" onClick={() => onEmailChange(row.id)}>{row.label}</button> : row.label}<div className="mt-1 flex flex-wrap gap-2 text-[11px] font-normal text-muted-foreground">{row.shared && <span className="rounded border px-1.5">Shared mailbox</span>}{row.assignments.some(assignment => assignment.archived) && <span>Archived assignment</span>}{row.unassigned && <span>Unassigned</span>}{row.syncStatus !== "ready" && <span>{row.syncStatus === "unavailable" ? "Outside retention" : row.syncStatus === "partial" ? "Partially synced" : "Not synced"}</span>}</div>{!!row.assignments.length && <p className="mt-1 text-[11px] font-normal text-muted-foreground">{row.assignments.some(assignment => assignment.archived) ? "Assignments" : "Current assignments"}: {[...new Set(row.assignments.map(assignment => `${assignment.bidder_name} · ${assignment.profile_label}${assignment.archived ? " (archived)" : ""}`))].join(", ")}</p>}{group !== "email" && <p className="mt-1 break-all text-[11px] font-normal text-muted-foreground">{row.emails.join(", ")}</p>}</th><td className="px-3 py-3 tabular-nums">{row.found}</td><td className="px-3 py-3 tabular-nums">{row.applied}</td>{tableCategories.map(id => <td className="px-3 py-3 tabular-nums" key={id}>{row.categories ? row.categories[id] : <span className="text-muted-foreground">{row.syncStatus === "unavailable" ? "Unavailable" : "Not synced"}</span>}</td>)}</tr>)}{!result?.groups.length && <tr><td colSpan={8} className="py-8 text-center text-muted-foreground">{loading ? "Loading activity…" : report ? "No assigned mailboxes or uploaded metrics in this scope." : "Email activity unavailable."}</td></tr>}</tbody>{result && <tfoot><tr className="font-semibold"><th className="py-3 pr-4 text-left" scope="row">Unique totals</th><td className="px-3">{result.totals.found}</td><td className="px-3">{result.totals.applied}</td>{tableCategories.map(id => <td className="px-3" key={id}>{mailAvailable ? result.categories[id] : "—"}</td>)}</tr></tfoot>}</table></div>
    </div>
    {report && <div className="space-y-2 text-[11px] text-muted-foreground"><p>Published: {freshness(report.received_at)} · Generated: {freshness(report.generated_at)}</p><details><summary className="cursor-pointer font-medium">Mailbox coverage and freshness</summary><ul className="mt-2 space-y-1">{report.mailboxes.filter(mailbox => isManager || report.assignments.some(assignment => assignment.email === mailbox.email)).map(mailbox => <li key={mailbox.email}>{mailbox.email} · {mailbox.coverage_start ? `Coverage from ${mailbox.coverage_start} CT` : "Coverage unknown"} · Last collected: {freshness(mailbox.collected_at)}</li>)}</ul></details></div>}
  </section>;
}
