import { handleReportBundle } from "@/lib/report-bundle-server";
export async function GET(request: Request, context: { params: Promise<{ kind: string }> }) {
  return handleReportBundle(request, (await context.params).kind);
}
