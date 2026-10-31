"use client";
import { useCallback } from "react";
import { fetchMailInsights } from "@/lib/mail-insights-report";
import type { ReportQuery } from "@/lib/report-types";
import { readKey } from "@/lib/read-state";
import { useReadScope } from "@/lib/read-scope";
import { useCalendarDay } from "./period-selector";
import { useReport } from "./use-report";

export type MailReportContext = { role?: string; workspaces?: { id: string; name: string }[]; workspaceId?: string };
export function useMailReport(query: ReportQuery, workspaceRequired = false) {
  const scope = useReadScope();
  const day = useCalendarDay();
  const needsWorkspace = workspaceRequired && !query.workspace;
  const request = useCallback(() => needsWorkspace ? Promise.resolve({ error: "Choose a workspace to view email insights." }) : fetchMailInsights(query), [query, needsWorkspace]);
  const result = useReport(readKey(scope, "mail-insights", { query, needsWorkspace }, day), request);
  return { ...result, needsWorkspace };
}
export type MailReportState = ReturnType<typeof useMailReport>;
