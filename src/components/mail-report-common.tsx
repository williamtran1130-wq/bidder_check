"use client";
import type { MailMetric } from "@/lib/mail-metrics";
import { unavailableMailMetric } from "@/lib/mail-metrics";
import type { MailReportState } from "./use-mail-report";
import { Button } from "./ui/button";

export function MailCount({ metric = unavailableMailMetric, field = "confirmations" }: { metric?: MailMetric; field?: "confirmations" | "invitations" }) {
  const count = metric[field];
  return <span className="tabular-nums">{count === null ? "—" : count.toLocaleString()}{count === null && metric.status !== "unavailable" && <span className="ml-1 text-[11px] font-normal text-muted-foreground">{metric.status === "outside_retention" ? "Unavailable" : "Not synced"}</span>}</span>;
}
export function MailReportNotice({ mail }: { mail: MailReportState }) {
  const report = mail.data;
  return <div className="my-3 space-y-1 text-xs text-muted-foreground" aria-label="Email metric coverage">
    {mail.needsWorkspace ? <p role="status">Choose a workspace to view email metrics.</p> : mail.error ? <p role="alert">{mail.error} <Button size="sm" variant="outline" onClick={mail.refresh} disabled={mail.loading}>Retry email metrics</Button></p> : !report ? <p>{mail.loading ? "Loading email metrics…" : "Email metrics unavailable."}</p> : null}
  </div>;
}
export function ReportWorkspaceSelector({ value, onChange, workspaces }: { value: string; onChange: (value: string) => void; workspaces: { id: string; name: string }[] }) {
  return <label className="space-y-1 text-xs text-muted-foreground"><span>Workspace</span><select className="native-select block text-foreground" value={value} onChange={event => onChange(event.target.value)}><option value="">All workspaces</option>{workspaces.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>;
}
