import { getWorkspaceData } from "@/lib/data";
import { getNotificationPage } from "@/app/(workspace)/notification-actions";
import { Notifications } from "@/components/notifications";
export default async function Page() {
  const data = await getWorkspaceData({ scope: "notifications" });
  const [inbox, messages] = await Promise.all([
    data.profile.role !== "client"
      ? getNotificationPage({ kind: "inbox" })
      : Promise.resolve(undefined),
    data.profile.role !== "bidder"
      ? getNotificationPage({
          kind: "messages",
          workspace_id: data.workspaces[0]?.id,
        })
      : Promise.resolve(undefined),
  ]);
  return (
    <Notifications
      data={data}
      initialInboxPage={inbox}
      initialMessagesPage={messages}
    />
  );
}
