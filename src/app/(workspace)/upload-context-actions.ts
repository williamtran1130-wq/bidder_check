"use server";
import { getContext } from "@/lib/auth";
import { z } from "zod";
import type { UploadContext, UploadContextCursor, UploadHistoryPage } from "@/lib/upload-context-types";

type ReviewResult<T> = { data?: T; error?: string };
async function manager() {
  const context = await getContext();
  const { profile } = context;
  if (!profile || !["admin", "client"].includes(profile.role) || profile.archived || profile.approval_status !== "approved") throw new Error("Access denied");
  return context.supabase;
}
const cursorSchema = z.object({ uploadedAt: z.iso.datetime({ offset: true }), id: z.uuid() });

/** Called only when a manager opens the current screenshot preview. */
export async function getScreenshotUploadContext(fileId: string): Promise<ReviewResult<UploadContext | null>> {
  try {
    const supabase = await manager();
    const { data, error } = await supabase.rpc("manager_screenshot_upload_context", { p_file: z.uuid().parse(fileId) });
    if (error) return { error: "Upload details could not be loaded. Please retry." };
    return { data: data as UploadContext | null };
  } catch { return { error: "Upload details could not be loaded. Please retry." }; }
}

/** Keyset pagination is fixed at 50 and authorization runs for every page. */
export async function getScreenshotUploadHistory(bidId: string, cursor?: UploadContextCursor | null): Promise<ReviewResult<UploadHistoryPage>> {
  try {
    const supabase = await manager();
    const parsedCursor = cursor ? cursorSchema.parse(cursor) : null;
    const { data, error } = await supabase.rpc("manager_screenshot_upload_history", {
      p_bid: z.uuid().parse(bidId), p_before_at: parsedCursor?.uploadedAt ?? null, p_before_id: parsedCursor?.id ?? null,
    });
    if (error || !data) return { error: "Upload history could not be loaded. Please retry." };
    return { data: data as UploadHistoryPage };
  } catch { return { error: "Upload history could not be loaded. Please retry." }; }
}
