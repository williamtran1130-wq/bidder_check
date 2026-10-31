import "server-only";
import { z } from "zod";
import { getActor, AuthorizationError } from "./auth";
import { isCalendarDate, resolveCalendarPeriod } from "./calendar-period";
import { MailApiError, mailFailure, mailJson, mailReadActor } from "./mail-insights-server";
import type { CollectionStatus, KindReport, ReportBundle, ReportKind } from "./report-bundle";
import type { GroupedReportQuery, ReportQuery, ReportResult } from "./report-types";

const inputSchema = z.object({
  from: z.string().refine(isCalendarDate).optional(), to: z.string().refine(isCalendarDate).optional(),
  workspace: z.uuid().optional(), bidder: z.uuid().optional(), profile: z.uuid().optional(), email: z.email().max(320).optional(),
  group: z.enum(["profile", "bidder", "assignment"]).optional(),
}).strict().refine(value => Boolean(value.from) === Boolean(value.to) && (!value.from || !value.to || value.from <= value.to));
type Input = z.infer<typeof inputSchema>;
async function read<K extends ReportKind>(actor: Awaited<ReturnType<typeof getActor>>, kind: K, input: Input): Promise<ReportBundle<KindReport[K]>> {
  const started = performance.now();
  if (kind === "earnings" && actor.profile.role === "bidder") throw new MailApiError(403, "You do not have access to this report.");
  const { data, error } = await actor.supabase.rpc("workspace_report_bundle", {
    p_kind: kind, p_from: input.from ?? null, p_to: input.to ?? null,
    p_workspace: input.workspace ?? null, p_bidder: input.bidder ?? null, p_profile: input.profile ?? null,
    p_email: input.email?.trim().toLowerCase() ?? null, p_group: input.group ?? "profile",
  });
  const forbidden = error && (error.code === "42501" || /^Access denied\b/i.test(error.message));
  const durationMs = Math.round(performance.now() - started);
  if (error || durationMs >= 500 || (process.env.NODE_ENV === "production" && Math.random() < 0.01)) console.info("Report bundle", { kind, durationMs, outcome: error ? "failed" : "success", ...(error ? { code: error.code } : {}) });
  if (error) throw new MailApiError(forbidden ? 403 : error.code === "22023" ? 400 : 503, forbidden ? "You do not have access to this report." : "Report unavailable. Please retry.");
  if (!data || typeof data !== "object" || !("report" in data) || !("collection" in data)) throw new MailApiError(503, "Report unavailable. Please retry.");
  return data as unknown as ReportBundle<KindReport[K]>;
}
export async function readReportBundle<K extends ReportKind>(kind: K, query: ReportQuery | GroupedReportQuery): Promise<ReportResult<ReportBundle<KindReport[K]>> & { receivedAt?: number }> {
  try {
    const range = resolveCalendarPeriod(query.period);
    const input = inputSchema.parse({ ...range, workspace: query.workspace, bidder: query.bidder, profile: query.profile, email: query.email, group: "group" in query ? query.group : undefined });
    return { data: await read(await getActor(), kind, input), receivedAt: Date.now() };
  } catch (error) {
    if (error instanceof AuthorizationError) throw error;
    return { error: error instanceof MailApiError ? error.message : "Report unavailable. Please retry.", code: error instanceof MailApiError && error.status === 403 ? "forbidden" : "temporarily_unavailable" };
  }
}
export async function handleReportBundle(request: Request, kind: string) {
  try {
    const actor = await mailReadActor(request);
    if (!["overview", "interviews", "earnings"].includes(kind)) throw new MailApiError(404, "Unknown report.");
    const input = inputSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return mailJson(await read(actor, kind as ReportKind, input));
  } catch (error) { return mailFailure(error); }
}
export async function readCollectionStatus(workspace?: string): Promise<ReportResult<CollectionStatus> & { receivedAt?: number }> {
  try {
    const actor = await getActor();
    const { data, error } = await actor.supabase.rpc("mail_collection_status", { p_workspace: workspace ?? null });
    if (error) return { error: "Collection status unavailable.", code: error.code === "42501" || /^Access denied\b/i.test(error.message) ? "forbidden" : "temporarily_unavailable" };
    return { data: data as CollectionStatus, receivedAt: Date.now() };
  } catch (error) { if (error instanceof AuthorizationError) throw error; return { error: "Collection status unavailable." }; }
}
