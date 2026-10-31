import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Earnings } from "@/components/earnings";
import { getContext } from "@/lib/auth";
import { redirect } from "next/navigation";
import { readReport } from "@/lib/reporting-server";
import type { EarningsReport } from "@/lib/report-types";
import { actorReadScope } from "@/lib/read-keys";
import { readKey } from "@/lib/read-state";
import { calendarToday } from "@/lib/calendar-period";
async function Content() {
  const context = await getContext();
  if (context.profile.role === "bidder") redirect("/dashboard");
  const day = calendarToday(),
    query = {
      period: { preset: "this_week" as const },
      group: "bidder" as const,
    };
  const result = await readReport<EarningsReport>(
    "earnings_performance_v2",
    query,
  );
  return (
    <Earnings
      mailContext={{ role: context.profile.role, workspaces: context.workspaces.map(({ id, name }) => ({ id, name })) }}
      initial={{
        key: readKey(actorReadScope(context), "earnings", query, day),
        result,
      }}
    />
  );
}
export default function Page() {
  return (
    <Suspense fallback={<PageLoading label="Loading earnings…" />}>
      <Content />
    </Suspense>
  );
}
