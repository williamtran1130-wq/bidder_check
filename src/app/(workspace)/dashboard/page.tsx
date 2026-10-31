import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { getDashboardData } from "@/lib/data";
import { Dashboard } from "@/components/dashboard";
import { readReportBundle } from "@/lib/report-bundle-server";
import { actorReadScope } from "@/lib/read-keys";
import { readKey } from "@/lib/read-state";
import { calendarToday } from "@/lib/calendar-period";
async function Content() {
  const day = calendarToday();
  const query = { period: { preset: "this_week" as const } };
  const [data, result] = await Promise.all([
    getDashboardData(),
    readReportBundle("overview", query),
  ]);
  return (
    <Dashboard
      data={data}
      initial={{
        receivedAt: result.receivedAt,
        key: readKey(actorReadScope(data), "bundle-overview", query, day),
        result,
      }}
    />
  );
}
export default function Page() {
  return (
    <Suspense fallback={<PageLoading label="Loading dashboard…" />}>
      <Content />
    </Suspense>
  );
}
