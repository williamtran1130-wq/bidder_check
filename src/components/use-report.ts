"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReportResult } from "@/lib/report-types";
import { ReadRequests, seedFor, type ReadSeed } from "@/lib/read-state";
/** Exact-query state; explicit refresh invalidates, ordinary focus deduplicates. */
export function useReport<T>(
  key: string,
  fetchReport: () => Promise<ReportResult<T>>,
  initial?: ReadSeed<T>,
) {
  const seeded = seedFor(key, initial);
  const hasSeed = !!seeded;
  const [state, setState] = useState<{
    key: string;
    data?: T;
    loading: boolean;
    error?: string;
  }>(() => ({
    key,
    data: seeded?.data,
    error: seeded?.error,
    loading: !seeded,
  }));
  const [revision, setRevision] = useState(0);
  const requests = useRef(new ReadRequests<ReportResult<T>>());
  const initialKey = useRef(key);
  const began = useRef(false);
  const refresh = useCallback(() => {
    requests.current.invalidate();
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    if (
      key === initialKey.current &&
      revision === 0 &&
      hasSeed &&
      !began.current
    )
      return;
    began.current = true;
    let current = true;
    const run = async () => {
      setState((previous) => ({
        key,
        data: previous.key === key ? previous.data : undefined,
        loading: true,
      }));
      const ticket = requests.current.load(key, async () => {
        try {
          return await fetchReport();
        } catch {
          return {
            error: "This report is temporarily unavailable. Please retry.",
            code: "temporarily_unavailable",
          };
        }
      });
      // Never retry an expensive read automatically, including statement timeouts.
      const result = await ticket.promise;
      if (current && requests.current.current(ticket))
        setState((previous) => ({
          key,
          data:
            result.code === "forbidden"
              ? undefined
              : (result.data ??
                (previous.key === key ? previous.data : undefined)),
          loading: false,
          error: result.error,
        }));
    };
    const timer = setTimeout(() => void run(), 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key, fetchReport, revision, hasSeed]);
  useEffect(() => {
    let lastFocus = 0;
    const focus = () => {
      if (Date.now() - lastFocus < 1000) return;
      lastFocus = Date.now();
      setRevision((value) => value + 1);
    };
    const revoked = () => {
      requests.current.invalidate();
      setState({ key, loading: false });
    };
    window.addEventListener("focus", focus);
    window.addEventListener("workspace-access-revoked", revoked);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("workspace-access-revoked", revoked);
    };
  }, [key]);
  return state.key === key
    ? { ...state, refresh }
    : { key, data: undefined, loading: true, error: undefined, refresh };
}
