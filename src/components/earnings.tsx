"use client";
import { PageLoading } from "./page-loading";
import { useMemo, useState } from "react";
import { Wallet, CheckCheck, FileText } from "lucide-react";
import { usd } from "@/lib/domain";
import { PageHeading, EmptyState } from "./common";
import { Button } from "./ui/button";
import type { PeriodSelection } from "@/lib/calendar-period";
import { PeriodSelector } from "./period-selector";
import { useReportBundle } from "./use-report-bundle";
import type { ReportBundle } from "@/lib/report-bundle";
import { type ReadSeed } from "@/lib/read-state";
import type { EarningsReport as SeedReport } from "@/lib/report-types";
import { type MailReportContext } from "./use-mail-report";
import { mergeMailGroups, projectMailMetrics } from "@/lib/mail-metrics";
import { MailCount, MailReportNotice, ReportWorkspaceSelector } from "./mail-report-common";
export function Earnings({
  bidderId,
  initial,
  embedded = false,
  mailContext = {},
}: {
  bidderId?: string;
  initial?: ReadSeed<ReportBundle<SeedReport>>;
  embedded?: boolean;
  mailContext?: MailReportContext;
}) {
  const [period, setPeriod] = useState<PeriodSelection>({ preset: "this_week" });
  const [group, setGroup] = useState("bidder");
  const [workspaceSelection, setWorkspace] = useState(mailContext.workspaceId ?? "");
  const workspace = mailContext.workspaceId ?? (mailContext.workspaces?.some(row => row.id === workspaceSelection) ? workspaceSelection : "");
  const query = useMemo(() => ({ period, bidder: bidderId, group: group === "bidder" ? "bidder" as const : "assignment" as const, ...(workspace ? { workspace } : {}) }), [period, bidderId, group, workspace]);
  const bundle = useReportBundle("earnings", query, initial);
  const { report, loading, error, refresh, mail } = bundle;
  const metrics = projectMailMetrics(mail.error ? undefined : mail.data, query.group);
  const total = report?.totals;
  const groups = mergeMailGroups(report?.groups ?? [], metrics.groups, row => ({ id: row.id, label: row.label, sub: "Assigned mailbox activity", count: 0, cents: 0, applied: 0, interviews: 0 }));
  return (
    <>
      {!embedded && (
        <PageHeading
          eyebrow="THE VALUE OF YOUR PROGRESS"
          title="Every effort adds up."
          description="Earnings from saved bid rates and first application dates."
        />
      )}
      <div className="panel mb-6 flex flex-wrap items-end justify-between gap-4 p-5">
        <div className="flex gap-1">
          {["bidder", "resume"].map((g) => (
            <Button
              key={g}
              size="sm"
              variant={group === g ? "secondary" : "ghost"}
              onClick={() => setGroup(g)}
            >
              By {g}
            </Button>
          ))}
        </div>
        {mailContext.role === "admin" && !mailContext.workspaceId && <ReportWorkspaceSelector value={workspace} onChange={setWorkspace} workspaces={mailContext.workspaces ?? []} />}
        <PeriodSelector label="First applied period" value={period} onChange={setPeriod} />
        <Button size="sm" variant="outline" onClick={refresh} disabled={loading || mail.loading}>Refresh reports</Button>
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Total earned", value: total ? usd(total.cents) : "—", icon: Wallet },
          {
            label: "Qualifying applications",
            value: total?.count ?? "—",
            icon: CheckCheck,
          },
          {
            label: "Applications received",
            value: <MailCount metric={metrics.total} />,
            icon: CheckCheck,
          },
          {
            label: "Resumes with earnings",
            value: total?.resumes ?? "—",
            icon: FileText,
          },
        ].map((s) => (
          <div className="panel p-5" key={s.label}>
            <div className="flex justify-between text-xs text-muted-foreground">
              {s.label}
              <s.icon size={18} className="text-primary" />
            </div>
            <p className="mt-4 text-3xl font-semibold tracking-tight">
              {s.value}
            </p>
          </div>
        ))}
      </div>
      <MailReportNotice mail={mail} />
      <section className="panel p-5">
        {error && <p role="alert" aria-label="Earnings reporting error" className="mb-4 text-sm text-destructive">{error}{report ? " Showing the last successful results for these filters." : ""} <Button size="sm" variant="outline" disabled={loading} onClick={refresh}>Retry</Button></p>}
        {loading && <PageLoading label="Loading earnings…" size="section" />}
        {!loading && report && !groups.length ? (
          <EmptyState
            title="No active earnings rows"
            description="No active assignments have earnings in this period."
          />
        ) : !loading && total ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="border-y text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-3 font-semibold">
                    {group === "bidder" ? "Team member" : "Resume profile"}
                  </th>
                  <th className="p-3 text-right font-semibold">Applications</th>
                  <th className="p-3 text-right font-semibold">Applications received</th>
                  <th className="py-3 text-right font-semibold">
                    Earnings (USD)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {groups.map((g) => (
                  <tr key={g.id}>
                    <td className="py-4">
                      <p className="text-sm font-semibold">{g.label}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {g.sub}
                      </p>
                    </td>
                    <td className="p-3 text-right text-sm">
                      {g.count}
                    </td>
                    <td className="p-3 text-right text-sm"><MailCount metric={metrics.groups.get(g.id)?.metric} /></td>
                    <td className="py-4 text-right text-sm font-semibold">
                      {usd(g.cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t">
                <tr>
                  <td className="pt-4 font-semibold">Total</td>
                  <td className="pt-4 text-right font-semibold">
                    {total.count}
                  </td>
                  <td className="pt-4 text-right font-semibold"><MailCount metric={metrics.total} /></td>
                  <td className="pt-4 text-right font-semibold text-primary">
                    {usd(total.cents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : null}
        <p className="mt-6 rounded-lg bg-background p-3 text-[11px] leading-5 text-muted-foreground">
          Earnings use each bid’s saved rate and first application date.
          Unapplied bids are excluded; reapplying restores the original amount.
          This is an earnings record, not a payment or payout balance. Reporting
          dates use Central Time (America/Chicago), including daylight saving time.
        </p>
          {!!total?.retainedCount && <p className="mt-3 text-xs text-muted-foreground">Includes {total.retainedCount} retained historical applications. Their individual application details have been removed.</p>}
      </section>
    </>
  );
}
