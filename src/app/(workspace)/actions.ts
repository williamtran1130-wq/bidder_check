"use server";
import * as reads from "@/lib/read-services";
import { getContext } from "@/lib/auth";
import { adminClient } from "@/lib/admin";
import {
  normalizeJobUrl,
  moneyToCents,
  validateUpload,
} from "@/lib/domain";
import type { Database } from "@/lib/database.types";
import { type BidListLoadResult, type BidListQuery } from "@/lib/bid-list";
import { createHash } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { unstable_rethrow } from "next/navigation";
import { actionErrorMessage, ActionValidationError } from "@/lib/action-errors";
import { editableBidField, workArrangement, jobStatus, importDate, importRows } from "@/lib/action-validation";
import { centralWallTimeToISO } from "@/lib/central-time";
import { z } from "zod";
import { validateScreenshotBytes } from "@/lib/image-validation";
import { headers } from "next/headers";
import { captureUploadContext } from "@/lib/upload-context";
import { runStorageCleanup } from "@/lib/storage-cleanup";
import type {
  BidTarget,
  CleanupOutcome,
  PurgeResult,
  PurgeSnapshot,
  PurgeStatus,
} from "@/lib/bulk-types";
import { canRetryPurge } from "@/lib/purge-status";
import { readReport } from "@/lib/reporting-server";
import { submitAccountOperation, resumeAccountOperation, accountRecoveryList, abandonAccountOperation } from "@/lib/account-operation-server";
import type { AccountKind } from "@/lib/account-operation-types";
import type { BidRow } from "@/lib/workspace-types";
import type { DashboardReport, EarningsReport, InterviewReport, ReportQuery, GroupedReportQuery } from "@/lib/report-types";
export type { DashboardReport, EarningsReport, InterviewReport } from "@/lib/report-types";

type Result<T = undefined> = { data?: T; error?: string };
export type BidRestoreIssue = { bidId: string; field: string; code: string; message: string };
export type DeletionResult = { deletedCount: number; status: PurgeStatus; outcome: CleanupOutcome };
async function finishDeletion(result: unknown): Promise<DeletionResult> {
  const deletion = result as { deletedCount: number; operationId: string };
  const outcome = await cleanupPass(deletion.operationId);
  return { deletedCount: deletion.deletedCount, outcome, status: await purgeStatus(deletion.operationId) };
}
export async function deleteBids(targets: BidTarget[]) {
  return perform(async () => finishDeletion(await rpc("delete_bids", {
    p_targets: z.array(z.object({ id: z.uuid(), version: z.number().int().nonnegative() })).min(1).max(500).parse(targets),
  })));
}
export async function deleteResumeAssignment(id: string) {
  return perform(async () => finishDeletion(await rpc("delete_resume_assignment", { p_id: z.uuid().parse(id) })));
}
export async function deleteCandidateProfile(id: string) {
  return perform(async () => finishDeletion(await rpc("delete_candidate_profile", { p_profile: z.uuid().parse(id) })));
}
async function perform<T>(
  fn: () => Promise<T>,
  mutate = true,
): Promise<Result<T>> {
  try {
    const data = await fn();
    // Authenticated routes are dynamic. Their caller refreshes only the
    // affected view; invalidating the workspace root also reruns its auth,
    // unread-count, and page-data waterfalls for unrelated screens.
    void mutate;
    return { data };
  } catch (e) {
    unstable_rethrow(e);
    return { error: actionErrorMessage(e) };
  }
}
async function rpc<N extends keyof Database["public"]["Functions"]>(
  name: N,
  args: Database["public"]["Functions"][N]["Args"],
) {
  const { supabase } = await getContext();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message), { details: error.details, code: error.code });
  return data;
}
const text = (form: FormData, key: string) =>
  String(form.get(key) ?? "").trim();
const id = (value: string) => (value ? z.uuid().parse(value) : null);
export type SaveBidOutcome = { status: "saved"; id: string } | { status: "blocked" };
export async function saveBid(form: FormData): Promise<Result<SaveBidOutcome>> {
  return perform(async (): Promise<SaveBidOutcome> => {
    const url = normalizeJobUrl(text(form, "url"));
    const bidId = id(text(form, "id"));
    try {
    const saved = await rpc("save_bid", {
      p_id: bidId,
      p_resume: z.uuid().parse(text(form, "resume_id")),
      p_company: z.string().min(1).max(200).parse(text(form, "company")),
      p_role: z.string().min(1).max(200).parse(text(form, "role_name")),
      p_url: url,
      p_source: text(form, "source"),
      p_arrangement: workArrangement.parse(text(form, "arrangement")),
      p_status: jobStatus.parse(text(form, "job_status")),
    });
    return { status: "saved", id: saved };
    } catch (error) {
      unstable_rethrow(error);
      if (!bidId && error && typeof error === "object" && "code" in error && error.code === "PBC01")
        return { status: "blocked" };
      throw error;
    }
  });
}
export async function saveResume(form: FormData) {
  return perform(
    async () =>
      await rpc("save_resume", {
        p_id: id(text(form, "id")),
        p_workspace: z.uuid().parse(text(form, "workspace_id")),
        p_bidder: z.uuid().parse(text(form, "bidder_id")),
        p_identifier: text(form, "identifier"),
        p_name: text(form, "candidate_name"),
        p_email: text(form, "email"),
        p_phone: text(form, "phone"),
        p_address: text(form, "address"),
        p_links: text(form, "links"),
        p_instructions: text(form, "instructions"),
        p_rate: moneyToCents(text(form, "rate")),
      }),
  );
}
export async function reviewBidAction(
  bid: string,
  status: "approved" | "rejected",
  reason: string,
  version: number,
) {
  return perform(async () => {
    const result = await rpc("review_bid", {
      p_bid: z.uuid().parse(bid),
      p_status: z.enum(["approved", "rejected"]).parse(status),
      p_reason: z.string().max(1000).parse(reason),
      p_version: z.number().int().nonnegative().parse(version),
    });
    if (result && typeof result === "object" && "conflict" in result && result.conflict === true) throw new Error("This bid changed. Refresh the current row before reviewing it.");
    return result;
  });
}
export async function reviewBidsAction(
  targets: { id: string; version: number }[],
  status: "approved" | "rejected",
  reason: string,
) {
  return perform(async () => rpc("review_bids", {
    p_targets: z.array(z.object({ id: z.uuid(), version: z.number().int().nonnegative() })).min(1).max(500).parse(targets),
    p_status: z.enum(["approved", "rejected"]).parse(status),
    p_reason: z.string().max(1000).parse(reason),
  }));
}
export async function resubmitBidAction(bid: string, version: number) {
  return perform(async () => {
    const result = await rpc("resubmit_bid", {
      p_bid: z.uuid().parse(bid),
      p_version: z.number().int().nonnegative().parse(version),
    });
    if (result && typeof result === "object" && "conflict" in result && result.conflict === true) throw new Error("This bid changed. Refresh the current row before resubmitting it.");
    return result;
  });
}
export async function setBidInterviewAction(input: {
  bid: string;
  scheduled: boolean;
  localTime: string;
  notes: string;
  reason: string;
}) {
  return perform(async () => {
    const localTime = z.string().parse(input.localTime).trim();
    const instant = localTime ? centralWallTimeToISO(localTime) : null;
    return rpc("set_bid_interview", {
      p_bid: z.uuid().parse(input.bid),
      p_scheduled: z.boolean().parse(input.scheduled),
      p_at: instant,
      p_notes: z.string().max(2000).parse(input.notes),
      p_reason: z.string().max(1000).parse(input.reason),
    });
  });
}
export async function saveClientMessageAction(form: FormData) {
  return perform(async () => {
    const { profile, workspaces } = await getContext();
    if (profile.role === "bidder") throw new Error("Access denied");
    const workspace = profile.role === "admin"
      ? z.uuid().parse(text(form, "workspace_id"))
      : workspaces[0]?.id;
    if (!workspace) throw new Error("Workspace not found");
    const kind = z.enum(["once", "daily", "weekly"]).parse(text(form, "schedule_kind"));
    const mode = z.enum(["all", "selected"]).parse(text(form, "recipient_mode"));
    const recipients = z.array(z.uuid()).max(500).parse(form.getAll("recipient_ids").map(String).filter(Boolean));
    const local = text(form, "scheduled_local");
    const sendNow = form.get("send_now") === "on";
    const draft = form.get("save_draft") === "on";
    const once = kind === "once" && !sendNow ? z.string().min(1).parse(local) : "";
    const weekdays = form.getAll("weekdays").map((day) => z.coerce.number().int().min(0).max(6).parse(day));
    return rpc("save_client_message", {
      p_id: id(text(form, "id")),
      p_workspace: workspace,
      p_title: z.string().trim().min(1).max(120).parse(text(form, "title")),
      p_body: z.string().trim().min(1).max(4000).parse(text(form, "body")),
      p_mode: mode,
      p_recipients: mode === "selected" ? recipients : [],
      p_kind: kind,
      p_scheduled_at: sendNow ? new Date().toISOString() : once ? fromZonedTime(once, "America/Chicago").toISOString() : null,
      p_local_time: kind === "once" ? null : z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).parse(text(form, "local_time")),
      p_weekdays: kind === "weekly" ? weekdays : [],
      p_draft: draft,
    });
  });
}
export async function setClientMessageStatusAction(idValue: string, status: "active" | "paused" | "cancelled") {
  return perform(async () => rpc("set_message_status", {
    p_id: z.uuid().parse(idValue),
    p_status: z.enum(["active", "paused", "cancelled"]).parse(status),
  }));
}
export async function getInboxNotifications() {
  return reads.getInboxNotifications();
}

export async function getUnreadNotificationCount() {
  return reads.getUnreadNotificationCount();
}

export async function getClientMessages() {
  return reads.getClientMessages();
}

export async function markInboxNotificationAction(notification: string, read: boolean) {
  return perform(async () => rpc("mark_notification_read", {
    p_id: z.uuid().parse(notification),
    p_read: z.boolean().parse(read),
  }));
}
export async function savePushSubscriptionAction(subscription: {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string };
}) {
  return perform(async () => rpc("save_push_subscription", {
    p_endpoint: z.url().parse(subscription.endpoint),
    p_p256dh: z.string().min(1).max(256).parse(subscription.keys?.p256dh),
    p_auth: z.string().min(1).max(256).parse(subscription.keys?.auth),
  }));
}
export async function deletePushSubscriptionAction(endpoint: string) {
  return perform(async () => rpc("delete_push_subscription", { p_endpoint: z.url().parse(endpoint) }));
}
export async function deleteAllPushSubscriptionsAction() {
  return perform(async () => rpc("delete_all_push_subscriptions", {}), false);
}
export async function saveCandidateProfile(form: FormData) {
  return perform(async () => {
    const { profile, workspaces } = await getContext();
    const workspace =
      profile.role === "admin"
        ? z.uuid().parse(text(form, "workspace_id"))
        : workspaces[0]?.id;
    if (!workspace) throw new Error("Workspace not found");
    return rpc("save_candidate_profile", {
      p_id: id(text(form, "id")),
      p_workspace: workspace,
      p_identifier: text(form, "identifier"),
      p_name: text(form, "candidate_name"),
      p_address: text(form, "address"),
      p_links: text(form, "links"),
      p_instructions: text(form, "instructions"),
    });
  });
}
export async function previewCandidateRetention(profile: string, months: number) {
  return perform(async () =>
    (await rpc("candidate_retention_preview", {
      p_profile: z.uuid().parse(profile),
      p_months: z.number().int().min(1).max(120).parse(months),
    })) as { eligible: number; cutoff: string },
    false,
  );
}
export async function saveCandidateProfileRules(input: {
  profile: string;
  companyLimit: number;
  retentionMonths: number | null;
  companies: string[];
  roles: string[];
  links: string[];
  confirmedEligible?: number | null;
}) {
  return perform(async () =>
    rpc("update_candidate_profile_rules", {
      p_profile: z.uuid().parse(input.profile),
      p_company_limit: z.number().int().min(1).max(1000).parse(input.companyLimit),
      p_retention_months: input.retentionMonths === null ? null : z.number().int().min(1).max(120).parse(input.retentionMonths),
      p_companies: z.array(z.string().trim().min(1).max(200)).max(100).parse(input.companies),
      p_roles: z.array(z.string().trim().min(1).max(200)).max(100).parse(input.roles),
      p_links: z.array(z.string().trim().min(1).max(200)).max(100).parse(input.links),
      p_confirm_eligible: input.confirmedEligible ?? null,
    }),
  );
}
export async function saveResumeAssignment(input: {
  id?: string;
  profileId: string;
  bidderId: string;
  email: string;
  phone: string;
  rate: string;
}) {
  return perform(async () => {
    const validated = z.object({
      id: z.uuid({ error: "Choose an assignment to update." }).optional(),
      profileId: z.uuid({ error: "Choose a candidate profile." }),
      bidderId: z.uuid({ error: "Choose a bidder." }),
      email: z.email({ error: "Enter a valid email address." }),
      phone: z.string().trim().min(1, "Enter a phone number.").max(100, "Phone number must be 100 characters or fewer."),
      rate: z.string(),
    }).safeParse({ ...input, email: input.email.trim() });
    if (!validated.success) {
      const issue = validated.error.issues[0];
      const label = ({ id: "Assignment", profileId: "Candidate profile", bidderId: "Bidder", email: "Email", phone: "Phone" } as Record<string, string>)[String(issue.path[0])] ?? "Assignment";
      throw new ActionValidationError(`${label}: ${issue.message}`);
    }
    const rate = moneyToCents(validated.data.rate);
    const assignment = await rpc("save_resume_assignment", {
      p_id: validated.data.id ?? null,
      p_profile: validated.data.profileId,
      p_bidder: validated.data.bidderId,
      p_email: validated.data.email,
      p_phone: validated.data.phone,
      p_file: null,
      p_rate: rate,
    });
    return assignment;
  });
}
export async function archiveCandidateProfile(profile: string, archived: boolean) {
  return perform(async () =>
    rpc("archive_candidate_profile", {
      p_profile: z.uuid().parse(profile),
      p_archived: z.boolean().parse(archived),
    }),
  );
}
export async function archiveResumeAssignment(
  assignment: string,
  archived: boolean,
) {
  return perform(async () =>
    rpc("archive_resume_assignment", {
      p_id: z.uuid().parse(assignment),
      p_archived: z.boolean().parse(archived),
    }),
  );
}
export async function archiveResume(resumeId: string, archived: boolean) {
  return perform(
    async () =>
      await rpc("archive_resume", { p_id: z.uuid().parse(resumeId), p_archived: z.boolean().parse(archived) }),
  );
}
export async function updateBidder(form: FormData, requestId?: string) {
  return submitAccountOperation("update_bidder", form, requestId);
}
export async function updateClient(form: FormData, requestId?: string) {
  return submitAccountOperation("update_client", form, requestId);
}
export async function reviewClient(
  account: string,
  status: "approved" | "rejected",
  reason: string,
) {
  return perform(async () =>
    rpc("review_client", {
      p_client: z.uuid().parse(account),
      p_status: z.enum(["approved", "rejected"]).parse(status),
      p_reason: z.string().parse(reason),
    }),
  );
}
export async function resetManagedPassword(account: string, confirmed: boolean, requestId?: string) {
  if (confirmed !== true) return { error: "Confirm the password reset first" };
  const form = new FormData();
  form.set("user_id", account);
  return submitAccountOperation("reset_password", form, requestId);
}
export async function createClientAccount(form: FormData, requestId?: string) {
  return submitAccountOperation("create_client", form, requestId);
}
export async function getManagedAccountOperations() { return accountRecoveryList(); }
export async function resumeManagedAccountOperation(request: string) { return resumeAccountOperation(request); }
export async function abandonManagedAccountOperation(request: string) { return abandonAccountOperation(request); }
export async function submitManagedAccountOperation(request: string, kind: AccountKind, fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return submitAccountOperation(kind, form, request);
}
export async function trashBid(bid: string, deleted: boolean): Promise<{ data?: undefined; error?: string; issues?: BidRestoreIssue[] }> {
  try {
    await rpc("trash_bid", { p_bid: z.uuid().parse(bid), p_deleted: z.boolean().parse(deleted) });
    return { data: undefined };
  } catch (error) {
    unstable_rethrow(error);
    const issues = restorationIssues(error, bid);
    return { error: issues?.map((issue) => issue.message).join(" ") ?? actionErrorMessage(error, "Could not update this bid. Please retry."), ...(issues ? { issues } : {}) };
  }
}

function restorationIssues(error: unknown, fallbackId: string): BidRestoreIssue[] | undefined {
  if ((error as { message?: unknown } | null)?.message !== "Restoration blocked") return undefined;
  const details = (error as { details?: unknown } | null)?.details;
  if (typeof details !== "string") return undefined;
  try {
    const parsed = JSON.parse(details) as {
      bidId?: string;
      issues?: Array<{ field?: string; code?: string; message?: string }>;
      restorationIssues?: Array<{ bidId?: string; issues?: Array<{ field?: string; code?: string; message?: string }> }>;
    };
    const blocked = parsed.restorationIssues ?? [{ bidId: parsed.bidId, issues: parsed.issues }];
    return blocked.flatMap((record) => (record.issues ?? []).flatMap((issue) => issue.message ? [{
      bidId: record.bidId ?? fallbackId,
      field: issue.field ?? "application",
      code: issue.code ?? "restore_blocked",
      message: issue.message,
    }] : []));
  } catch {
    return undefined;
  }
}
export async function createBidder(form: FormData, requestId?: string) {
  return submitAccountOperation("create_bidder", form, requestId);
}
export async function unapplyBid(bidId: string, reason: string) {
  return perform(
    async () =>
      await rpc("set_applied", {
        p_bid: z.uuid().parse(bidId),
        p_applied: false,
        p_file: null,
        p_reason: z.string().refine((value) => value.replace(/^ +| +$/g, "").length > 0).parse(reason),
      }),
  );
}
export async function saveSettings(form: FormData) {
  return perform(
    async () =>
      await rpc("save_settings", {
        p_name: text(form, "display_name"),
        p_workspace: id(text(form, "workspace_id")),
        p_workspace_name: text(form, "workspace_name"),
        p_timezone: text(form, "timezone"),
      }),
  );
}
export async function prepareUpload(
  kind: "resume" | "screenshot",
  target: string,
  name: string,
  mime: string,
  size: number,
) {
  return perform(async () => {
    z.enum(["resume", "screenshot"]).parse(kind);
    z.uuid().parse(target);
    z.number().int().parse(size);
    z.string().parse(name);
    validateUpload(kind, mime, size);
    adminClient();
    const { supabase } = await getContext();
    const { data, error } = await supabase.rpc("prepare_file", {
      p_kind: kind,
      p_target: target,
      p_name: name,
      p_mime: mime,
      p_size: size,
    });
    if (error) throw new Error(error.message);
    const { data: file, error: readError } = await supabase
      .from("files")
      .select("*")
      .eq("id", data!)
      .single();
    if (readError) throw new Error(readError.message);
    return file;
  });
}
function matchesSignature(bytes: Uint8Array, mime: string) {
  const head = Array.from(bytes.slice(0, 12));
  if (mime === "image/png")
    return head.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10";
  if (mime === "image/jpeg")
    return head[0] === 255 && head[1] === 216 && head[2] === 255;
  if (mime === "image/webp")
    return (
      Buffer.from(bytes.slice(0, 4)).toString() === "RIFF" &&
      Buffer.from(bytes.slice(8, 12)).toString() === "WEBP"
    );
  if (mime === "application/pdf")
    return Buffer.from(bytes.slice(0, 5)).toString() === "%PDF-";
  if (mime === "application/msword")
    return head.slice(0, 8).join(",") === "208,207,17,224,161,177,26,225";
  return head[0] === 80 && head[1] === 75 && head[2] === 3 && head[3] === 4;
}
export async function finalizeUpload(fileId: string) {
  return perform(async () => {
    z.uuid().parse(fileId);
    const { supabase, profile } = await getContext();
    const { data: file, error } = await supabase
      .from("files")
      .select("*")
      .eq("id", fileId)
      .single();
    if (error || !file) throw new Error("File not found.");
    if (file.created_by !== profile.id)
      throw new Error("Only the uploader can finalize this file.");
    // A verified immutable file is already committed. Lost-response retries need no second download.
    if (file.finalized) return file.id;
    // Download with the caller's JWT so storage RLS checks current access again.
    const { data: blob, error: downloadError } = await supabase.storage
      .from("private-files")
      .download(file.storage_path);
    if (downloadError || !blob)
      throw new Error("Upload has not completed. Please retry.");
    if (blob.size !== file.size_bytes)
      throw new Error("File size does not match the upload.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!matchesSignature(bytes, file.mime))
      throw new Error("The file contents do not match its type.");
    if (file.kind === "screenshot")
      await validateScreenshotBytes(bytes, file.mime);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const uploadContext = file.kind === "screenshot"
      ? captureUploadContext(await headers(), process.env.VERCEL === "1")
      : captureUploadContext(new Headers(), false);
    const { error: finalError } = await adminClient().rpc(
      "finalize_verified_file_v2",
      {
        p_actor: profile.id,
        p_id: file.id,
        p_sha: sha,
        p_context: uploadContext,
      },
    );
    if (finalError) throw new Error(finalError.message);
    return file.id;
  });
}
export async function getFileUrl(fileId: string) {
  return reads.getFileUrl(fileId);
}

export async function getBidHistory(bidId: string) {
  return reads.getBidHistory(bidId);
}

export async function getBidRows(
  mode: string,
  from: string,
  to: string,
  trash: boolean,
  bidderId: string | undefined,
  query: BidListQuery,
): Promise<BidListLoadResult> {
  return reads.getBidRows(mode, from, to, trash, bidderId, query);
}

export async function updateBidCell(
  bid: string,
  field: string,
  value: string,
  version: number,
) {
  return perform(
    async () =>
      (await rpc("update_bid_cell", {
        p_bid: z.uuid().parse(bid),
        p_field: editableBidField.parse(field),
        p_value:
          field === "url"
            ? normalizeJobUrl(value)
            // SQL checks row versions before state-dependent value constraints,
            // so invalid stale drafts still receive the current conflict row.
            : z.string().max(8192).parse(value),
        p_version: z.number().int().nonnegative().parse(version),
      })) as {
        ok?: boolean;
        conflict?: boolean;
        row: BidRow;
      },
    false,
  );
}
export async function checkBidImport(
  resume: string,
  date: string,
  rows: import("@/lib/sheets").ImportRow[],
) {
  return perform(async () => {
    if (Buffer.byteLength(JSON.stringify(rows)) > 2 * 1024 * 1024)
      throw new Error("Import payload is too large");
    return (await rpc("validate_bid_import", {
      p_resume: z.uuid().parse(resume),
      p_date: importDate.parse(date),
      p_rows: importRows.parse(rows),
    })) as import("@/lib/sheets").ImportError[];
  }, false);
}
export async function importBids(
  resume: string,
  date: string,
  rows: import("@/lib/sheets").ImportRow[],
  request: string,
): Promise<{ data?: { ids?: string[]; purgedCount?: number; errors?: import("@/lib/sheets").ImportError[]; date: string; bidder: string; resume: string }; error?: string; uncertain?: boolean }> {
  let sent = false;
  try {
    if (Buffer.byteLength(JSON.stringify(rows)) > 2 * 1024 * 1024)
      throw new Error("Import payload is too large");
    const args = {
      p_resume: z.uuid().parse(resume),
      p_date: importDate.parse(date),
      p_rows: importRows.parse(rows),
      p_request: z.uuid().parse(request),
    };
    const { supabase } = await getContext();
    sent = true;
    const { data, error } = await supabase.rpc("import_bids", args);
    if (error) {
      // SQL/PostgREST rejections have a definite outcome; transport failures do not.
      const definite = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(error.code ?? "");
      return { error: actionErrorMessage(error, "Could not complete import. Retry the same request."), uncertain: !definite };
    }
    if (!data) return { error: "The import response was incomplete. Retry the same request.", uncertain: true };
    return { data: data as {
      ids?: string[];
      purgedCount?: number;
      errors?: import("@/lib/sheets").ImportError[];
      date: string;
      bidder: string;
      resume: string;
    }, uncertain: false };
  } catch (error) {
    unstable_rethrow(error);
    return { error: actionErrorMessage(error, "Could not complete import. Retry the same request."), uncertain: sent };
  }
}

export async function reconcileBidTargets(targets: BidTarget[], trash: boolean) {
  return perform(async () => {
    const valid = z.array(z.object({ id: z.uuid(), version: z.number().int().nonnegative() })).max(500).parse(targets);
    return (await rpc("reconcile_bid_targets", { p_targets: valid, p_trash: trash })) as string[];
  }, false);
}

export async function manualApplyBidsAction(input: {
  targets: BidTarget[];
  localTime: string;
  reason: string;
  requestId: string;
}): Promise<Result<{ applied: number; unchanged: number }>> {
  return perform(async () => {
    const { profile } = await getContext();
    if (profile.role === "bidder") throw new Error("Only clients and admins can manually apply bids");
    const targets = z.array(z.object({ id: z.uuid(), version: z.number().int().nonnegative() })).min(1).max(500).parse(input.targets);
    const localTime = z.string().parse(input.localTime);
    const reason = z.string().trim().min(1).max(1000).parse(input.reason);
    const requestId = z.uuid().parse(input.requestId);
    const appliedAt = centralWallTimeToISO(localTime);
    return (await rpc("manual_apply_bids", {
      p_targets: targets,
      p_applied_at: appliedAt,
      p_reason: reason,
      p_request: requestId,
    })) as { applied: number; unchanged: number };
  });
}

export async function importReviewedBids(
  resume: string,
  date: string,
  rows: import("@/lib/sheets").ImportRow[],
  sourceRows: number[],
  request: string,
): Promise<{
  data?: {
    ids: string[];
    sourceRows: number[];
    skipped: unknown;
    date: string;
    bidder: string;
    resume: string;
  };
  error?: string;
  uncertain?: boolean;
}> {
  let sent = false;
  try {
    if (rows.length !== sourceRows.length || rows.length > 500)
      throw new Error("Import row mapping is invalid");
    if (Buffer.byteLength(JSON.stringify(rows)) > 2 * 1024 * 1024)
      throw new Error("Import payload is too large");
    const args = {
      p_resume: z.uuid().parse(resume),
      p_date: importDate.parse(date),
      p_rows: importRows.parse(rows),
      p_source_rows: sourceRows.map((row) => z.number().int().positive().parse(row)),
      p_request: z.uuid().parse(request),
    };
    const { supabase } = await getContext();
    sent = true;
    const { data, error } = await supabase.rpc("import_bids_reviewed", args);
    if (error) {
      if (error.code === "57014")
        return { error: "The database import timed out. No bids were committed; retry this batch. If the timeout repeats, split it into smaller batches." };
      const definite = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(error.code ?? "");
      return { error: actionErrorMessage(error, "Could not complete import. Retry the same request."), uncertain: !definite };
    }
    if (!data) return { error: "The import response was incomplete. Retry the same request.", uncertain: true };
    return { data: data as unknown as NonNullable<Awaited<ReturnType<typeof importReviewedBids>>["data"]> };
  } catch (error) {
    unstable_rethrow(error);
    return { error: actionErrorMessage(error, "Could not complete import. Retry the same request."), uncertain: sent };
  }
}

const bidTargets = z
  .array(z.object({ id: z.uuid(), version: z.number().int().nonnegative() }))
  .min(1)
  .max(500);
export async function bulkBidState(targets: BidTarget[], deleted: boolean): Promise<{ data?: number; error?: string; issues?: BidRestoreIssue[] }> {
  try {
    const count = await rpc("bulk_bid_state", {
      p_targets: bidTargets.parse(targets),
      p_deleted: z.boolean().parse(deleted),
    });
    return { data: count as number };
  } catch (error) {
    unstable_rethrow(error);
    const fallbackId = targets[0]?.id ?? "";
    const issues = !deleted ? restorationIssues(error, fallbackId) : undefined;
    return {
      error: issues?.map((issue) => issue.message).join(" ") ?? actionErrorMessage(error, "Could not update selected bids. Please retry."),
      ...(issues ? { issues } : {}),
    };
  }
}
export async function prepareBidPurge(
  mode: "selected" | "all",
  targets: BidTarget[],
  bidder?: string,
) {
  return perform(
    async () =>
      (await rpc("prepare_bid_purge", {
        p_mode: z.enum(["selected", "all"]).parse(mode),
        p_targets: mode === "selected" ? bidTargets.parse(targets) : [],
        p_bidder: bidder ? z.uuid().parse(bidder) : null,
      })) as PurgeSnapshot,
    false,
  );
}
const purgeStatus = async (op: string) =>
  (await rpc("bid_purge_status", { p_operation: op })) as PurgeStatus;
/** Run one cleanup pass for an operation; worker errors become an outcome, never a thrown error. */
async function cleanupPass(op: string): Promise<CleanupOutcome> {
  try {
    const result = await runStorageCleanup(op);
    if (!result.attempted) return "processing";
    return result.failed ? "failed" : "processed";
  } catch {
    return "failed";
  }
}
export async function confirmBidPurge(operation: string, confirmation: string) {
  return perform(async (): Promise<PurgeResult> => {
    if (confirmation !== "DELETE") throw new Error("Type DELETE to confirm.");
    const op = z.uuid().parse(operation);
    await rpc("confirm_bid_purge", { p_operation: op });
    // Application deletion succeeded even if Storage is temporarily unavailable.
    const outcome = await cleanupPass(op);
    return { status: await purgeStatus(op), outcome };
  });
}
export async function getPurgeStatus(operation: string) {
  return reads.getPurgeStatus(operation);
}

export async function retryPurgeCleanup(operation: string) {
  return perform(async (): Promise<PurgeResult> => {
    const op = z.uuid().parse(operation);
    const before = (await rpc("retry_bid_cleanup", {
      p_operation: op,
    })) as PurgeStatus;
    const now = Date.parse(before.serverTime);
    let outcome: CleanupOutcome;
    if (!before.pendingFiles) outcome = "processed";
    else if (before.processingFiles >= before.pendingFiles)
      outcome = "processing";
    else if (!canRetryPurge(before, now)) outcome = "waiting";
    else outcome = await cleanupPass(op);
    return { status: await purgeStatus(op), outcome };
  }, false);
}
export async function recentBidPurges() {
  return reads.recentBidPurges();
}

export async function getDashboardPerformance(input: ReportQuery) {
  return readReport<DashboardReport>("dashboard_performance_v2", input);
}

export async function getEarningsPerformance(input: GroupedReportQuery) {
  return readReport<EarningsReport>("earnings_performance_v2", input);
}
export async function getInterviewPerformance(input: GroupedReportQuery) {
  return readReport<InterviewReport>("interview_performance", input);
}
