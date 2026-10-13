import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { getWorkspaceData } from "@/lib/data";
import { BidWorkspace } from "@/components/bids";
import { getBidRows } from "@/lib/read-services";
import { bidReadKey, initialBidQuery } from "@/lib/read-keys";
import { calendarToday } from "@/lib/calendar-period";
async function Content({
  searchParams,
}: {
  searchParams: Promise<{ review?: string }>;
}) {
  const review = (await searchParams).review === "pending";
  const mode = review ? "all" : "today",
    query = initialBidQuery(review),
    day = calendarToday();
  const [data, result] = await Promise.all([
    getWorkspaceData({ scope: "bids" }),
    getBidRows(mode, "", "", false, undefined, query),
  ]);
  return (
    <BidWorkspace
      data={data}
      initial={{
        key: bidReadKey(data, mode, "", "", false, undefined, query, day),
        result,
      }}
    />
  );
}
export default function Page(props: {
  searchParams: Promise<{ review?: string }>;
}) {
  return (
    <Suspense fallback={<PageLoading label="Loading bids…" />}>
      <Content {...props} />
    </Suspense>
  );
}
