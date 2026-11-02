import "server-only";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getActor } from "./auth";
import { assertLiveSession } from "./live-session";
import { AuthorizationError } from "./authorization-error";
import { isCalendarDate } from "./calendar-period";
import type { Database } from "./database.types";

export class MailApiError extends Error {
  constructor(public status: number, message: string, public destination?: string) { super(message); }
}
export const mailJson = (data: unknown, status = 200) => Response.json(data, {
  status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization" },
});
export async function mailBearerActor(request: Request) {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new MailApiError(401, "Sign in to bidder-check to upload metrics.");
  const supabase = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${match[1]}` } },
  });
  const { data, error } = await supabase.auth.getUser(match[1]);
  if (error) {
    const invalid = [400, 401, 403].includes(error.status ?? 0) && error.name !== "AuthRetryableFetchError";
    if (invalid || error.name === "AuthSessionMissingError")
      throw new MailApiError(401, "Your session expired. Sign in again.");
    throw new MailApiError(503, "Authentication is temporarily unavailable. Sync will retry.");
  }
  if (!data.user) throw new MailApiError(401, "Your session expired. Sign in again.");
  try { await assertLiveSession(supabase); }
  catch (error) {
    if (error instanceof AuthorizationError) throw new MailApiError(401, "Your session expired. Sign in again.");
    throw new MailApiError(503, "Session verification is temporarily unavailable. Sync will retry.");
  }
  const { data: profile, error: profileError } = await supabase.from("profiles").select("id,role,archived,approval_status").eq("id", data.user.id).single();
  if (profileError?.code === "PT401") throw new MailApiError(401, "Your session expired. Sign in again.");
  if (profileError) throw new MailApiError(503, "Could not verify your account. Please retry.");
  if (!profile || profile.archived || (profile.role === "client" && profile.approval_status !== "approved"))
    throw new MailApiError(403, "Your account is not active and approved.");
  return { supabase, user: data.user, profile };
}
export async function mailReadActor(request: Request) {
  if (request.headers.has("authorization")) return mailBearerActor(request);
  try { return await getActor(); }
  catch (error) {
    if (error && typeof error === "object" && "destination" in error)
      throw new MailApiError(error.destination === "/auth/login" ? 401 : 403, "Your access changed. Please sign in again.", String(error.destination));
    throw error;
  }
}
export function mailFailure(error: unknown) {
  if (error instanceof MailApiError) return mailJson({ error: error.message, ...(error.destination ? { destination: error.destination } : {}) }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return mailJson({ error: "Invalid metrics request." }, 400);
  return mailJson({ error: "Email metrics are temporarily unavailable. Please retry." }, 503);
}
const timestamp = z.string().max(80).datetime({ offset: true }).refine(value => /(?:Z|\+00:00)$/.test(value));
const date = z.string().refine(isCalendarDate);
const mailboxSchema = z.object({
  email: z.email().max(320).refine(value => value === value.trim().toLowerCase()), account_label: z.string().max(200),
  collected_at: timestamp.nullable(), coverage_start: date.nullable(),
  rows: z.array(z.object({ date, category: z.enum(["application_ack", "interview_invite", "assessment", "offer", "info_request", "recruiter_outreach", "rejection", "job_alert", "other", "unclassified"]),
    handled: z.boolean(), action_required: z.boolean(), retryable: z.boolean(), count: z.number().int().min(0).max(1000000000),
  }).strict()).max(50000),
}).strict();
const snapshotV1 = z.object({
  schema_version: z.literal(1), client_id: z.uuid(), revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  generated_at: timestamp, timezone: z.literal("America/Chicago"),
  mailboxes: z.array(z.object({
    email: z.email().max(320).refine(value => value === value.trim().toLowerCase()), account_label: z.string().max(200),
    collected_at: timestamp.nullable(), coverage_start: date.nullable(),
    rows: z.array(z.object({ date, category: z.enum(["application_ack", "interview_invite", "assessment", "offer", "info_request", "recruiter_outreach", "rejection", "job_alert", "other", "unclassified"]),
      handled: z.boolean(), action_required: z.boolean(), retryable: z.boolean(), count: z.number().int().min(0).max(1000000000),
    }).strict()).max(50000),
  }).strict()).max(500),
}).strict();
const snapshotV2Base = {
  schema_version: z.literal(2), client_id: z.uuid(), revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  generated_at: timestamp, timezone: z.literal("America/Chicago"),
  removed_mailboxes: z.array(z.email().max(320).refine(value => value === value.trim().toLowerCase())).max(500),
};
export const snapshotSchema = z.union([
  snapshotV1,
  z.object({ ...snapshotV2Base, mode: z.literal("full"), mailboxes: z.array(mailboxSchema).max(500) }).strict(),
  z.object({ ...snapshotV2Base, mode: z.literal("delta"), base_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), mailboxes: z.array(mailboxSchema.partial({ rows: true })).max(500) }).strict(),
]);
export async function readBoundedSnapshot(request: Request) {
  const limit = 2 * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > limit) throw new MailApiError(413, "Metrics snapshot exceeds 2 MiB.");
  if (!request.body) throw new MailApiError(400, "A metrics snapshot is required.");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new MailApiError(413, "Metrics snapshot exceeds 2 MiB."); }
      parts.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return snapshotSchema.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
}
