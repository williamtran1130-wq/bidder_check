import { z } from "zod";
import { mailFailure, mailJson, mailReadActor, MailApiError } from "@/lib/mail-insights-server";
export async function GET(request: Request) {
  try {
    const actor = await mailReadActor(request);
    const input = z.object({ workspace: z.uuid().optional() }).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
    const { data, error } = await actor.supabase.rpc("mail_collection_status", { p_workspace: input.workspace ?? null });
    if (error) throw new MailApiError(error.code === "42501" || /^Access denied\b/i.test(error.message) ? 403 : 503, "Collection status unavailable.");
    return mailJson(data);
  } catch (error) { return mailFailure(error); }
}
