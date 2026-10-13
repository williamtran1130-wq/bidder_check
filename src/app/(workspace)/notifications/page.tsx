import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { getWorkspaceData } from "@/lib/data";
import { getNotificationPage } from "@/lib/notification-reads";
import { Notifications } from "@/components/notifications";
async function Content() {
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

export default function Page() {
  return (
    <Suspense fallback={<PageLoading label="Loading notifications…" />}>
      <Content />
    </Suspense>
  );
}
