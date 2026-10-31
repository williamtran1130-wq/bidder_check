import { z } from "zod";
import { isCalendarDate } from "@/lib/calendar-period";
import { MailApiError, mailFailure, mailJson, mailReadActor } from "@/lib/mail-insights-server";
const schema = z.object({
  from: z.string().refine(isCalendarDate).optional(), to: z.string().refine(isCalendarDate).optional(),
  workspace: z.uuid().optional(), bidder: z.uuid().optional(), profile: z.uuid().optional(), email: z.email().max(320).optional(),
}).strict().refine(value => Boolean(value.from) === Boolean(value.to) && (!value.from || !value.to || value.from <= value.to));
export async function GET(request: Request) {
  try {
    const actor = await mailReadActor(request);
    const input = schema.parse(Object.fromEntries(new URL(request.url).searchParams));
    if (actor.profile.role === "admin" && !input.workspace) throw new MailApiError(400, "Choose a workspace to view email insights.");
    const { data, error } = await actor.supabase.rpc("mail_insights_report", {
      p_from: input.from ?? null, p_to: input.to ?? null, p_workspace: input.workspace ?? null,
      p_bidder: input.bidder ?? null, p_profile: input.profile ?? null, p_email: input.email?.trim().toLowerCase() ?? null,
    });
    if (error) {
      if (error.code === "42501" || /Access denied/.test(error.message)) throw new MailApiError(403, "You do not have access to this report.");
      throw new Error("Metrics read failed");
    }
    return mailJson(data);
  } catch (error) { return mailFailure(error); }
}
