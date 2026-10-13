"use client";
import { PageLoading } from "./page-loading";
import { useCallback, useState } from "react";
import { Wallet, CheckCheck, FileText } from "lucide-react";
import { usd } from "@/lib/domain";
import { PageHeading, EmptyState } from "./common";
import { Button } from "./ui/button";
import { getEarningsPerformance } from "@/lib/read-client";
import type { PeriodSelection } from "@/lib/calendar-period";
import { PeriodSelector, useCalendarDay } from "./period-selector";
import { useReport } from "./use-report";
import { readKey, type ReadSeed } from "@/lib/read-state";
import type { EarningsReport as SeedReport } from "@/lib/report-types";
import { useReadScope } from "@/lib/read-scope";
export function Earnings({
  bidderId,
  initial,
  embedded = false,
}: {
  bidderId?: string;
  initial?: ReadSeed<SeedReport>;
  embedded?: boolean;
}) {
  const scope = useReadScope();
  const [period, setPeriod] = useState<PeriodSelection>({ preset: "this_week" });
  const [group, setGroup] = useState("bidder");
  const day = useCalendarDay();
  const request = useCallback(() => getEarningsPerformance({ period, bidder: bidderId, group: group === "bidder" ? "bidder" : "assignment" }), [period, bidderId, group]);
  const { data: report, loading, error, refresh } = useReport(readKey(scope, "earnings", { period, bidder: bidderId, group: group === "bidder" ? "bidder" : "assignment" }, day), request, initial);
  const total = report?.totals;
  const groups = report?.groups ?? [];
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
        <PeriodSelector label="First applied period" value={period} onChange={setPeriod} />
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        {[
          { label: "Total earned", value: total ? usd(total.cents) : "—", icon: Wallet },
          {
            label: "Qualifying applications",
            value: total?.count ?? "—",
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
      <section className="panel p-5">
        {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}{report ? " Showing the last successful results for these filters." : ""} <Button size="sm" variant="outline" disabled={loading} onClick={refresh}>Retry</Button></p>}
        {loading && <PageLoading label="Loading earnings…" size="section" />}
        {!loading && report && !groups.length ? (
          <EmptyState
            title="Progress you can put a number on"
            description="Once an application is marked applied, its earnings will appear here."
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
