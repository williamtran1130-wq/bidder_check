import { MailApiError, mailBearerActor, mailFailure, mailJson, readBoundedSnapshot } from "@/lib/mail-insights-server";
export const maxDuration = 30;
export async function POST(request: Request) {
  try {
    const actor = await mailBearerActor(request);
    if (actor.profile.role !== "client") throw new MailApiError(403, "Only approved clients can upload metrics.");
    const payload = await readBoundedSnapshot(request);
    if (payload.client_id !== actor.user.id) throw new MailApiError(403, "The snapshot belongs to a different client.");
    const { data, error } = await actor.supabase.rpc("ingest_mail_insights", { p_snapshot: payload });
    if (error) {
      if (error.code === "42501") throw new MailApiError(403, "Your account cannot upload metrics.");
      if (error.code === "22023") throw new MailApiError(400, "Invalid or expired metrics snapshot. Rebuild and sync again.");
      throw new Error("Metrics ingestion failed");
    }
    const conflict = data && typeof data === "object" && "code" in data && data.code === "revision_conflict";
    return mailJson(data, conflict ? 409 : 200);
  } catch (error) { return mailFailure(error); }
}
