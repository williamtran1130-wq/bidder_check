"use client";
import { useCallback, useEffect } from "react";
import { fetchReportBundle, type KindReport, type ReportBundle, type ReportKind } from "@/lib/report-bundle";
import type { GroupedReportQuery, ReportQuery } from "@/lib/report-types";
import { readKey, type ReadSeed } from "@/lib/read-state";
import { useReadScope } from "@/lib/read-scope";
import { useCalendarDay } from "./period-selector";
import { useReport } from "./use-report";

export function useReportBundle<K extends ReportKind>(kind: K, query: ReportQuery | GroupedReportQuery, initial?: ReadSeed<ReportBundle<KindReport[K]>>) {
  const scope = useReadScope();
  const day = useCalendarDay();
  const request = useCallback(() => fetchReportBundle(kind, query), [kind, query]);
  const state = useReport(readKey(scope, `bundle-${kind}`, query, day), request, initial);
  useEffect(() => {
    if (state.data) window.dispatchEvent(new CustomEvent("mail-collection-updated", { detail: { scope, workspace: query.workspace, collection: state.data.collection } }));
  }, [scope, query.workspace, state.data]);
  return {
    ...state, report: state.data?.report,
    mail: { key: state.key, data: state.data?.mail ?? undefined, loading: state.loading, error: state.error, refresh: state.refresh, needsWorkspace: !!state.data && state.data.mail === null },
  };
}
