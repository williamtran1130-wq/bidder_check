import { MailApiError, mailBearerActor, mailFailure, mailJson } from "@/lib/mail-insights-server";
export async function GET(request: Request) {
  try {
    const actor = await mailBearerActor(request);
    if (actor.profile.role !== "client") throw new MailApiError(403, "Sign in with an approved client account.");
    const { data, error } = await actor.supabase.rpc("mail_insights_connection");
    if (error) throw new MailApiError(error.code === "42501" ? 403 : 503, "Could not verify your client connection.");
    return mailJson(data);
  } catch (error) { return mailFailure(error); }
}
