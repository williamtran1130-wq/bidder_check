"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReportResult } from "@/lib/report-types";

/** Only keep results for the exact query; in-flight refreshes share one request. */
export function useReport<T>(key: string, fetchReport: () => Promise<ReportResult<T>>) {
  const [state, setState] = useState<{ key: string; data?: T; loading: boolean; error?: string }>({ key, loading: true });
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(new Map<string, Promise<ReportResult<T>>>());
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    const run = async () => {
      setState((previous) => ({ key, data: previous.key === key ? previous.data : undefined, loading: true }));
      let request = inFlight.current.get(key);
      if (!request) {
        const execute = async () => {
          for (let attempt = 0; ; attempt++) {
            let result: ReportResult<T>;
            try { result = await fetchReport(); }
            catch { result = { error: "This report is temporarily unavailable. Please retry.", code: "temporarily_unavailable" }; }
            if (result.code !== "temporarily_unavailable" || attempt === 1) return result;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        };
        request = execute();
        inFlight.current.set(key, request);
        const requests = inFlight.current;
        void request.finally(() => { if (requests.get(key) === request) requests.delete(key); });
      }
      const result = await request;
      if (current) setState((previous) => ({ key, data: result.data ?? (previous.key === key ? previous.data : undefined), loading: false, error: result.error }));
    };
    const timer = setTimeout(() => void run(), 0);
    return () => { current = false; clearTimeout(timer); };
  }, [key, fetchReport, revision]);
  useEffect(() => {
    let lastFocus = 0;
    const focus = () => {
      if (Date.now() - lastFocus < 1000) return;
      lastFocus = Date.now();
      refresh();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [refresh]);
  return state.key === key ? { ...state, refresh } : { key, data: undefined, loading: true, error: undefined, refresh };
}
