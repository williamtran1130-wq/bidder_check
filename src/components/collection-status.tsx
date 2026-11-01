"use client";
import { useCallback, useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import type { CollectionStatus } from "@/lib/report-bundle";
import type { ReportResult } from "@/lib/report-types";
import { readKey } from "@/lib/read-state";
import { browserReports } from "@/lib/report-cache";
import { latestCollection } from "@/lib/collection-status";
import { useCalendarDay } from "./period-selector";
import { useReport } from "./use-report";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function CollectionStatusPanel({ scope, role, workspaces, initial, receivedAt, collapsed = false }: {
  scope: string; role: string; workspaces: { id: string; name?: string }[];
  initial?: ReportResult<CollectionStatus>; receivedAt?: number; collapsed?: boolean;
}) {
  const [workspaceSelection, setWorkspace] = useState(workspaces[0]?.id ?? "");
  const workspace = workspaces.some(row => row.id === workspaceSelection) ? workspaceSelection : workspaces[0]?.id ?? "";
  const [published, setPublished] = useState<{ key: string; value: CollectionStatus; receivedAt: number }>();
  const day = useCalendarDay();
  const key = readKey(scope, "collection-status", workspace, day);
  const request = useCallback(async (): Promise<ReportResult<CollectionStatus>> => {
    if (!workspace && role === "admin") return { data: { status: "not_synced", updatedAt: null, from: null, to: null } };
    try {
      const response = await fetch(`/api/mail-insights/status${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          window.dispatchEvent(new Event("workspace-access-revoked"));
          window.location.assign(response.status === 401 ? "/auth/login" : "/dashboard");
        }
        return { error: "Collection status unavailable.", code: response.status === 401 || response.status === 403 ? "forbidden" : "temporarily_unavailable" };
      }
      return { data: await response.json() };
    } catch { return { error: "Collection status unavailable." }; }
  }, [workspace, role]);
  const state = useReport(key, request, workspace === workspaces[0]?.id && initial ? { key, result: initial, receivedAt } : undefined);
  useEffect(() => {
    const timer = setTimeout(() => {
      try { const saved = sessionStorage.getItem(`collection-workspace:${scope}`); if (saved && workspaces.some(row => row.id === saved)) setWorkspace(saved); } catch { /* Storage is optional. */ }
    }, 0);
    return () => clearTimeout(timer);
  }, [scope, workspaces]);
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ scope: string; workspace?: string; collection: CollectionStatus }>).detail;
      if (detail.scope !== scope || (detail.workspace ? detail.workspace !== workspace : role === "admin" || workspaces.length > 1)) return;
      browserReports.seed(key, { data: detail.collection });
      setPublished({ key, value: detail.collection, receivedAt: Date.now() });
    };
    window.addEventListener("mail-collection-updated", update);
    return () => window.removeEventListener("mail-collection-updated", update);
  }, [scope, workspace, key, role, workspaces.length]);
  const status = latestCollection(state.data ? { value: state.data, receivedAt: state.receivedAt ?? 0 } : undefined, published?.key === key && !state.error ? published : undefined);
  const updated = status?.updatedAt ? formatInTimeZone(status.updatedAt, "America/Chicago", "MMM d, yyyy h:mm a 'CT'") : "Not synced";
  const period = status?.status === "ready" && status.from && status.to ? `${status.from} – ${status.to} CT` : "Not synced";
  const details = <div className="space-y-2 text-[11px] leading-5"><p><span className="block text-muted-foreground">Updated</span>{state.loading && !status ? "Loading…" : updated}</p><p><span className="block text-muted-foreground">Collected period</span>{period}</p>{state.error && <p role="alert">{state.error} <button className="underline" onClick={state.refresh}>Retry</button></p>}</div>;
  if (collapsed) return <Tooltip><TooltipTrigger asChild><button className="mx-auto my-3 block rounded border p-2 text-xs" aria-label="Mail Check collection status">MC</button></TooltipTrigger><TooltipContent side="right">{details}</TooltipContent></Tooltip>;
  return <section className="mx-4 mb-5 rounded-lg border bg-background p-3" aria-label="Mail Check collection status">
    {role === "admin" && <label className="mb-3 block text-[11px] text-muted-foreground">Mail workspace<select aria-label="Mail status workspace" className="native-select mt-1 w-full text-foreground" value={workspace} onChange={event => { setWorkspace(event.target.value); try { sessionStorage.setItem(`collection-workspace:${scope}`, event.target.value); } catch { /* Optional. */ } }}>{workspaces.map(row => <option key={row.id} value={row.id}>{row.name ?? "Workspace"}</option>)}</select></label>}
    {details}
  </section>;
}
