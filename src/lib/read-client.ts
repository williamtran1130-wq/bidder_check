"use client";
import type * as reads from "./read-services";
import type {
  ReportQuery,
  GroupedReportQuery,
  ReportResult,
  DashboardReport,
  EarningsReport,
  InterviewReport,
} from "./report-types";
import type { ReadFailure } from "./read-types";
async function request<T>(
  operation: string,
  input: unknown = null,
): Promise<T> {
  const payload = JSON.stringify(input);
  const query = `/api/read/${operation}?q=${encodeURIComponent(payload)}`;
  const post =
    operation === "files" ||
    query.length > 1800;
  try {
    const response = await fetch(post ? `/api/read/${operation}` : query, {
      method: post ? "POST" : "GET",
      cache: "no-store",
      credentials: "same-origin",
      ...(post
        ? { headers: { "Content-Type": "application/json" }, body: payload }
        : {}),
    });
    const result = (await response.json()) as T & Partial<ReadFailure>;
    if (
      result.destination &&
      ["/auth/login", "/auth/approval", "/auth/inactive"].includes(
        result.destination,
      ) &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new Event("workspace-access-revoked"));
      window.location.assign(result.destination);
    }
    return result;
  } catch {
    return { error: "This request could not be completed. Please retry." } as T;
  }
}
export const getBidRows: typeof reads.getBidRows = (...args) =>
  request("bids", args);
export const getBidHistory: typeof reads.getBidHistory = (id) =>
  request("history", id);
export const getFileUrls: typeof reads.getFileUrls = (ids) =>
  request("files", ids);
export const getFileUrl: typeof reads.getFileUrl = async (id) => {
  const result = await getFileUrls([id]);
  const file = result.data?.[0];
  return file?.data
    ? {
        data: {
          url: file.data.url,
          name: file.data.name,
          mime: file.data.mime,
        },
      }
    : { error: file?.error ?? result.error ?? "File is unavailable." };
};
export const getPurgeStatus: typeof reads.getPurgeStatus = (id) =>
  request("purge", id);
export const recentBidPurges: typeof reads.recentBidPurges = () =>
  request("purges");
export const getDashboardPerformance = (query: ReportQuery) =>
  request<ReportResult<DashboardReport>>("dashboard", query);
export const getEarningsPerformance = (query: GroupedReportQuery) =>
  request<ReportResult<EarningsReport>>("earnings", query);
export const getInterviewPerformance = (query: GroupedReportQuery) =>
  request<ReportResult<InterviewReport>>("interviews", query);
