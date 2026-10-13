import { Suspense } from "react";
import { getDashboardData } from "@/lib/data";
import { Dashboard } from "@/components/dashboard";
import { readReport } from "@/lib/reporting-server";
import type { DashboardReport } from "@/lib/report-types";
import { actorReadScope } from "@/lib/read-keys";
import { readKey } from "@/lib/read-state";
import { calendarToday } from "@/lib/calendar-period";
async function Content() {
  const day = calendarToday();
  const query = { period: { preset: "this_week" as const } };
  const [data, result] = await Promise.all([
    getDashboardData(),
    readReport<DashboardReport>("dashboard_performance_v2", query),
  ]);
  return (
    <Dashboard
      data={data}
      initial={{
        key: readKey(actorReadScope(data), "dashboard", query, day),
        result,
      }}
    />
  );
}
export default function Page() {
  return (
    <Suspense fallback={<p role="status">Loading dashboard…</p>}>
      <Content />
    </Suspense>
  );
}
