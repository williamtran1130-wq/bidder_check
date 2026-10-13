"use client";
import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { Copy, LoaderCircle } from "lucide-react";
import { getScreenshotUploadContext, getScreenshotUploadHistory } from "@/app/(workspace)/upload-context-actions";
import type { UploadContext, UploadHistoryPage } from "@/lib/upload-context-types";
import { Button } from "./ui/button";

function ContextRecord({ context }: { context: UploadContext }) {
  const [copyStatus, setCopyStatus] = useState("");
  const location = [context.city, context.region, context.country].filter(Boolean).join(", ");
  async function copy() {
    if (!context.ip) return;
    try { await navigator.clipboard.writeText(context.ip); setCopyStatus("IP address copied"); }
    catch { setCopyStatus("Could not copy. Select the IP address to copy it."); }
  }
  return <div className="min-w-0 space-y-2">
    <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
      <div><dt className="text-muted-foreground">Uploaded by</dt><dd>{context.uploaderName || "Uploader unavailable"} ({context.uploaderRole})</dd></div>
      <div><dt className="text-muted-foreground">Uploaded</dt><dd><time dateTime={context.uploadedAt}>{formatInTimeZone(new Date(context.uploadedAt), "America/Chicago", "MMM d, yyyy 'at' h:mm a 'CT'")}</time></dd></div>
      <div className="min-w-0"><dt className="text-muted-foreground">IP address</dt><dd className="flex min-w-0 items-start gap-2"><span className="min-w-0 select-text break-all font-mono">{context.ip || "Unavailable"}</span>{context.ip && <Button type="button" variant="ghost" size="icon-sm" aria-label="Copy IP address" onClick={() => void copy()}><Copy size={14} /></Button>}</dd></div>
      <div><dt className="text-muted-foreground">Approximate IP location</dt><dd className="break-words">{location || "Unavailable"}</dd></div>
    </dl>
    {copyStatus && <p role="status" className="text-xs text-muted-foreground">{copyStatus}</p>}
    <p className="text-[11px] text-muted-foreground">IP location is approximate. VPNs and proxies may affect the location.</p>
  </div>;
}
function Loading() { return <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="animate-spin" size={14} />Loading upload details…</p>; }
function isManager(role: string) { return role === "client" || role === "admin"; }

// The parent mounts these only in an opened preview/details view. Required role
// gating also prevents accidental bidder calls or stale display on role changes.
export function UploadDetails({ fileId, role }: { fileId: string; role: string }) {
  const [retry, setRetry] = useState(0);
  const scope = `${role}:${fileId}:${retry}`;
  const [loaded, setLoaded] = useState<{ scope: string; data?: UploadContext | null; error?: string } | null>(null);
  useEffect(() => {
    if (!isManager(role)) return;
    let cancelled = false;
    void getScreenshotUploadContext(fileId).then((result) => { if (!cancelled) setLoaded({ scope, ...result }); })
      .catch(() => { if (!cancelled) setLoaded({ scope, error: "Upload details could not be loaded. Please retry." }); });
    return () => { cancelled = true; };
  }, [fileId, role, scope]);
  if (!isManager(role)) return null;
  const result = loaded?.scope === scope ? loaded : null;
  return <section aria-label="Upload details" className="min-w-0 space-y-2 rounded-lg border bg-muted/20 p-3">
    <h3 className="text-sm font-semibold">Upload details</h3>
    {!result ? <Loading /> : result.error ? <div className="space-y-2"><p role="alert" className="text-xs text-destructive">{result.error}</p><Button type="button" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry upload details</Button></div>
      : result.data ? <ContextRecord key={result.data.id} context={result.data} /> : <p className="text-xs text-muted-foreground">Not recorded. Upload details were not collected for this historical screenshot.</p>}
  </section>;
}

export function UploadHistory({ bidId, role }: { bidId: string; role: string }) {
  const [retry, setRetry] = useState(0);
  const scope = `${role}:${bidId}:${retry}`;
  const [loaded, setLoaded] = useState<{ scope: string; data?: UploadHistoryPage; error?: string } | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState("");
  useEffect(() => {
    if (!isManager(role)) return;
    let cancelled = false;
    void getScreenshotUploadHistory(bidId).then((result) => { if (!cancelled) setLoaded({ scope, ...result }); })
      .catch(() => { if (!cancelled) setLoaded({ scope, error: "Upload history could not be loaded. Please retry." }); });
    return () => { cancelled = true; };
  }, [bidId, role, scope]);
  const result = loaded?.scope === scope ? loaded : null;
  async function more() {
    if (moreBusy || !result?.data?.nextCursor || !isManager(role)) return;
    setMoreBusy(true); setMoreError("");
    try {
      const next = await getScreenshotUploadHistory(bidId, result.data.nextCursor);
      if (!next.data) { setMoreError(next.error || "Upload history could not be loaded. Please retry."); return; }
      setLoaded((previous) => previous?.scope === scope && previous.data ? { scope, data: { items: [...previous.data.items, ...next.data!.items], nextCursor: next.data!.nextCursor } } : previous);
    } catch { setMoreError("Upload history could not be loaded. Please retry."); }
    finally { setMoreBusy(false); }
  }
  if (!isManager(role)) return null;
  return <section aria-label="Upload history" className="min-w-0 space-y-3">
    <h3 className="text-sm font-semibold">Upload history</h3>
    {!result ? <Loading /> : result.error ? <div className="space-y-2"><p role="alert" className="text-xs text-destructive">{result.error}</p><Button type="button" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry upload history</Button></div>
      : result.data?.items.length ? <ol className="space-y-3">{result.data.items.map((context) => <li key={context.id} className="min-w-0 space-y-2 rounded-lg border bg-muted/20 p-3"><p className="text-xs font-medium">{context.fileAvailable ? context.filename || "Screenshot" : "Screenshot unavailable"}</p><ContextRecord context={context} /></li>)}</ol>
        : <p className="text-xs text-muted-foreground">Not recorded. No upload details have been recorded for this bid.</p>}
    {result?.data?.nextCursor && <Button type="button" variant="outline" size="sm" disabled={moreBusy} onClick={() => void more()}>{moreBusy ? "Loading uploads…" : "Load more uploads"}</Button>}
    {moreError && <p role="alert" className="text-xs text-destructive">{moreError}</p>}
  </section>;
}
