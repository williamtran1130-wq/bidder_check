export {
  getBidRows,
  getBidHistory,
  getFileUrl,
  getPurgeStatus,
  getDashboardPerformance,
  getEarningsPerformance,
  getInterviewPerformance,
  getInboxNotifications,
  getUnreadNotificationCount,
  getClientMessages,
} from "./actions";
export {
  getNotificationPage,
  getNotificationById,
  getNotificationUnreadCount,
  getNotificationDeviceEnabled,
} from "./notification-actions";
import { getFileUrl } from "./actions";
import { recentBidPurges as fixtureRecentBidPurges } from "./actions";
import { recentBidPurges as readRecentBidPurges } from "../../src/lib/read-client";
import type { FileUrlOutcome } from "@/lib/read-types";
export const recentBidPurges = () =>
  new URLSearchParams(location.search).has("purge-read-transport")
    ? readRecentBidPurges()
    : fixtureRecentBidPurges();
export async function getFileUrls(
  ids: string[],
): Promise<{ data?: FileUrlOutcome[]; error?: string }> {
  document.documentElement.dataset.fileBatchReads = String(
    Number(document.documentElement.dataset.fileBatchReads ?? 0) + 1,
  );
  document.documentElement.dataset.fileBatchIds = JSON.stringify(ids);
  if (
    new URLSearchParams(location.search).has("read-fixes") &&
    document.documentElement.dataset.thumbnailError === "true"
  )
    return { error: "Fixture preview unavailable" };
  return {
    data: await Promise.all(
      ids.map(async (id) => {
        const result = await getFileUrl();
        return "data" in result
          ? {
              id,
              data: {
                name: "proof.png",
                mime: "image/png",
                ...result.data,
                expiresAt: new Date(Date.now() + 60000).toISOString(),
              },
            }
          : { id, error: result.error };
      }),
    ),
  };
}
