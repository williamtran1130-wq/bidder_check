"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReportResult } from "@/lib/report-types";
import { seedFor, type ReadSeed } from "@/lib/read-state";
import { browserReports, REPORT_FRESH_MS } from "@/lib/report-cache";

/** Exact-query state with shared requests, bounded freshness and explicit retry. */
export function useReport<T>(key: string, fetchReport: () => Promise<ReportResult<T>>, initial?: ReadSeed<T>) {
  const seeded = seedFor(key, initial);
  const [state, setState] = useState<{ key: string; data?: T; loading: boolean; error?: string; receivedAt?: number }>(() => ({ key, data: seeded?.data, error: seeded?.error, loading: !seeded, receivedAt: initial?.receivedAt }));
  const [revision, setRevision] = useState(0);
  const force = useRef(false);
  const seededKey = useRef<string | undefined>(undefined);
  const refresh = useCallback(() => { force.current = true; browserReports.invalidate(key); setRevision(v => v + 1); }, [key]);
  useEffect(() => {
    let current = true;
    if (seeded && revision === 0 && (!initial?.receivedAt || Date.now() - initial.receivedAt < REPORT_FRESH_MS)) {
      if (seededKey.current !== key || !browserReports.peek(key)) { browserReports.seed(key, { data: seeded.data, error: seeded.error }, initial?.receivedAt); seededKey.current = key; }
      const activeSeed = browserReports.peek<T>(key) ?? seeded;
      const timer = setTimeout(() => setState({ key, data: activeSeed.data, error: activeSeed.error, loading: false, receivedAt: browserReports.timestamp(key) ?? initial?.receivedAt }), 0);
      return () => { current = false; clearTimeout(timer); };
    }
    if (document.visibilityState === "hidden") return;
    const run = async () => {
      setState(previous => ({ key, data: previous.key === key ? previous.data : undefined, loading: true }));
      const forced = force.current; force.current = false;
      const result = await browserReports.load(key, async () => {
        try { return await fetchReport(); }
        catch { return { error: "This report is temporarily unavailable. Please retry.", code: "temporarily_unavailable" }; }
      }, forced);
      if (current) setState(previous => ({ key, data: result.code === "forbidden" ? undefined : result.data ?? (previous.key === key ? previous.data : undefined), loading: false, error: result.error, receivedAt: browserReports.timestamp(key) ?? Date.now() }));
    };
    const timer = setTimeout(() => void run(), 0);
    return () => { current = false; clearTimeout(timer); };
  }, [key, fetchReport, revision, seeded, initial?.receivedAt]);
  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    let timer: ReturnType<typeof setTimeout>;
    const reconcile = () => {
      clearTimeout(timer);
      if (!visible()) return;
      if (state.key !== key || !browserReports.peek(key)) setRevision(v => v + 1);
      else timer = setTimeout(reconcile, Math.max(1, browserReports.remaining(key)));
    };
    const changed = () => { browserReports.invalidate(key); if (visible()) setRevision(v => v + 1); };
    const revoked = () => { browserReports.clear(); setState({ key, loading: false }); };
    if (!state.loading) timer = setTimeout(reconcile, browserReports.remaining(key) || REPORT_FRESH_MS);
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("workspace-data-changed", changed);
    window.addEventListener("workspace-access-revoked", revoked);
    return () => {
      clearTimeout(timer); window.removeEventListener("focus", reconcile); document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("workspace-data-changed", changed); window.removeEventListener("workspace-access-revoked", revoked);
    };
  }, [key, state.key, state.loading, state.data]);
  return state.key === key ? { ...state, refresh } : { key, data: undefined, loading: true, error: undefined, refresh };
}
