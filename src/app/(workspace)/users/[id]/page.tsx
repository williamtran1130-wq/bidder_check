import { getWorkspaceData } from "@/lib/data";
import { notFound } from "next/navigation";
import { BidderDetail } from "@/components/bidder-detail";
import { z } from "zod";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const data = await getWorkspaceData({ scope: "bidder-detail", bidderId: id, includeBidCounts: true });
  if (
    data.profile.role === "bidder" ||
    !data.bidders.some((b) => b.user_id === id)
  )
    notFound();
  return <BidderDetail data={data} id={id} />;
}
