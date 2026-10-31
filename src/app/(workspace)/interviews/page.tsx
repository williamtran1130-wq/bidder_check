import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { InterviewReport } from "@/components/interviews";
import { getContext } from "@/lib/auth";
import { readReportBundle } from "@/lib/report-bundle-server";
import { actorReadScope } from "@/lib/read-keys";
import { readKey } from "@/lib/read-state";
import { calendarToday } from "@/lib/calendar-period";
async function Content() {
  const context = await getContext(),
    day = calendarToday(),
    query = { period: { preset: "all" as const }, group: "profile" as const };
  const result = await readReportBundle("interviews", query);
  return (
    <InterviewReport
      mailContext={{ role: context.profile.role, workspaces: context.workspaces.map(({ id, name }) => ({ id, name })) }}
      initial={{
        receivedAt: result.receivedAt,
        key: readKey(actorReadScope(context), "bundle-interviews", query, day),
        result,
      }}
    />
  );
}
export default function Page() {
  return (
    <Suspense fallback={<PageLoading label="Loading interviews…" />}>
      <Content />
    </Suspense>
  );
}
