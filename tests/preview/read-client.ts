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
export { getScreenshotUploadContexts } from "./upload-context-actions";
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
  const token = document.documentElement.dataset.fileBatchReads;
  if (document.documentElement.dataset.delayNextFiles === "true") {
    document.documentElement.dataset.delayNextFiles = "false";
    await new Promise<void>((resolve) => window.addEventListener("fixture-release-files", () => resolve(), { once: true }));
  }
  if (
    (new URLSearchParams(location.search).has("read-fixes") || new URLSearchParams(location.search).has("egress")) &&
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
                ...(new URLSearchParams(location.search).has("egress") ? {
                  url: `https://images.example.test/${id}.png?token=${token}`,
                } : {}),
                expiresAt: new Date(Date.now() + 60000).toISOString(),
              },
            }
          : { id, error: result.error };
      }),
    ),
  };
}
