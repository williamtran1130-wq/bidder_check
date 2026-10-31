import type { MailMetricGroup } from "@/lib/mail-metrics";
import { MailCount } from "./mail-report-common";
import type { ArrangementCounts, ComparisonRow } from "@/lib/report-types";
import { applicationRate } from "@/lib/dashboard-report";

const arrangements = [
  { key: "remote", label: "Remote", color: "bg-[#8576ed] dark:bg-[#9c8fff]" },
  { key: "onsiteHybrid", label: "Onsite/hybrid", color: "bg-[#34b991] dark:bg-[#55cda8]" },
  { key: "unspecified", label: "Unspecified", color: "bg-slate-400 dark:bg-slate-500" },
] as const;

function completion(counts: ArrangementCounts) {
  const rate = applicationRate(counts.found, counts.foundApplied);
  return rate === null ? "—" : `${rate.toFixed(1)}%`;
}

function ArrangementBar({ row, measure, maximum }: { row: ComparisonRow; measure: "found" | "foundApplied"; maximum: number }) {
  const label = measure === "found" ? "Found" : "Applied";
  const counts = row.arrangements!;
  return <div role="img" aria-label={`${row.label} ${label}: ${row[measure].toLocaleString()} total; ${arrangements.map((arrangement) => `${arrangement.label} ${counts[arrangement.key][measure].toLocaleString()}`).join("; ")}.`}>
    <div aria-hidden="true" className="grid grid-cols-[3rem_minmax(0,1fr)_3rem] items-center gap-2 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <div className="h-3 rounded-sm bg-muted/35">
        <div className="flex h-full overflow-hidden rounded-sm" style={{ width: `${row[measure] / maximum * 100}%` }}>
          {arrangements.map((arrangement) => <span key={arrangement.key} className={arrangement.color} style={{ width: `${row[measure] ? counts[arrangement.key][measure] / row[measure] * 100 : 0}%` }} />)}
        </div>
      </div>
      <span className="text-right tabular-nums">{row[measure].toLocaleString()}</span>
    </div>
  </div>;
}

export function Comparison({ title, rows, loading, available, mailGroups }: { title: string; rows: ComparisonRow[]; loading: boolean; available: boolean; mailGroups?: Map<string, MailMetricGroup> }) {
  const sorted = [...rows].sort((a, b) => b.foundApplied - a.foundApplied || b.found - a.found || a.id.localeCompare(b.id));
  const shown = sorted.slice(0, 10);
  const maximum = Math.max(1, ...shown.flatMap((row) => [row.found, mailGroups?.get(row.id)?.metric.confirmations ?? 0]));
  const hasBreakdown = rows.some((row) => row.arrangements);
  const hasUnspecified = rows.some((row) => row.arrangements && (row.arrangements.unspecified.found > 0 || row.arrangements.unspecified.foundApplied > 0));
  return <section className="panel min-w-0 p-5" aria-label={title}>
    <h2 className="font-semibold">{title}</h2>
    <p className="mt-1 text-xs text-muted-foreground">Bids found, currently applied, and confirmation messages by current assignment. Email coverage can be shorter than the selected period.</p>
    {loading && !available ? <div className="mt-5 h-64 animate-pulse rounded bg-muted/50" /> : !available ? <p className="py-14 text-center text-sm text-muted-foreground">Comparison unavailable.</p> : !rows.length ? <p className="py-14 text-center text-sm text-muted-foreground">No bids found in this period.</p> : <>
      <div className="mt-5 space-y-5" role="group" aria-label={`${title}: found and applied bids, and confirmation emails. Exact values follow the chart.`}>
        {shown.map((row) => <div key={row.id} className="min-w-0">
          <p className="mb-2 break-words text-xs font-medium">{row.label}</p>
          {row.arrangements ? <div className="space-y-2">
            <ArrangementBar row={row} measure="found" maximum={maximum} />
            <ArrangementBar row={row} measure="foundApplied" maximum={maximum} />
          </div> : <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Found {row.found.toLocaleString()}</span><span>Applied {row.foundApplied.toLocaleString()}</span><span>Breakdown unavailable</span>
          </div>}
          {mailGroups && <div className="mt-2 space-y-1 text-xs" aria-label={`${row.label} confirmation emails`}>
            <p>Confirmations <MailCount metric={mailGroups.get(row.id)?.metric} />{mailGroups.get(row.id)?.metric.shared && <span className="ml-2 text-[11px] text-muted-foreground">Shared mailbox</span>}</p>
            <div aria-hidden="true" className="h-2 rounded-sm bg-muted/35"><div className="h-full rounded-sm bg-primary" style={{ width: `${(mailGroups.get(row.id)?.metric.confirmations ?? 0) / maximum * 100}%` }} /></div>
          </div>}
        </div>)}
      </div>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label="Arrangement legend">
        {hasBreakdown && arrangements.filter((arrangement) => arrangement.key !== "unspecified" || hasUnspecified).map((arrangement) => <span key={arrangement.key} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className={`size-2 rounded-sm ${arrangement.color}`} />{arrangement.label}</span>)}
        {rows.length > 10 && <span className="ml-auto">Top 10 of {rows.length}</span>}
      </div>
      {hasUnspecified && <p className="mt-2 text-[11px] text-muted-foreground">Older retained history may have no recorded arrangement.</p>}
      <details className="mt-4 border-t pt-3 text-xs">
        <summary className="cursor-pointer font-medium">View all comparison values</summary>
        <div className="mt-3 max-h-72 overflow-auto" tabIndex={0} role="region" aria-label={`${title} exact values`}>
          <table className="w-full min-w-[440px] text-right">
            <caption className="sr-only">{title} values</caption>
            <thead><tr className="text-muted-foreground"><th scope="col" className="py-2 pr-3 text-left">Name</th><th scope="col" className="pr-3 text-left">Arrangement</th><th scope="col" className="pr-3">Found</th><th scope="col" className="pr-3">Applied</th>{mailGroups && <th scope="col" className="pr-3">Confirmation emails</th>}<th scope="col">Completion</th></tr></thead>
            {sorted.map((row) => <tbody key={row.id} className="border-t">
              <tr>
                <th scope="rowgroup" rowSpan={row.arrangements ? 4 : 1} className="max-w-48 break-words py-2 pr-3 text-left align-top font-medium">{row.label}</th>
                <th scope="row" className="py-2 pr-3 text-left font-medium">Total{!row.arrangements && <span className="mt-1 block font-normal text-muted-foreground">Breakdown unavailable</span>}</th>
                <td className="pr-3 tabular-nums">{row.found.toLocaleString()}</td><td className="pr-3 tabular-nums">{row.foundApplied.toLocaleString()}</td>{mailGroups && <td className="pr-3 tabular-nums" rowSpan={row.arrangements ? 4 : 1}><MailCount metric={mailGroups.get(row.id)?.metric} /></td>}<td className="tabular-nums">{completion(row)}</td>
              </tr>
              {row.arrangements && arrangements.map((arrangement) => <tr key={arrangement.key}>
                <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted-foreground">{arrangement.label}</th>
                <td className="pr-3 tabular-nums">{row.arrangements![arrangement.key].found.toLocaleString()}</td><td className="pr-3 tabular-nums">{row.arrangements![arrangement.key].foundApplied.toLocaleString()}</td><td className="tabular-nums">{completion(row.arrangements![arrangement.key])}</td>
              </tr>)}
            </tbody>)}
          </table>
        </div>
      </details>
    </>}
  </section>;
}
