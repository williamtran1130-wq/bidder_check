import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { getNotificationUnreadCount } from "@/lib/notification-reads";
import { getContext } from "@/lib/auth";
import { Shell } from "@/components/shell";
export const dynamic = "force-dynamic";
async function Content({ children }: { children: React.ReactNode }) {
  const { profile, workspaces } = await getContext();
  return (
    <Shell
      profile={profile}
      initialUnread={
        profile.role === "client"
          ? undefined
          : await getNotificationUnreadCount()
      }
      notificationWorkspaces={workspaces}
      workspace={
        profile.role === "admin"
          ? "Platform overview"
          : (workspaces[0]?.name ?? "Workspace")
      }
    >
      {children}
    </Shell>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<PageLoading label="Loading workspace…" size="screen" />}>
      <Content>{children}</Content>
    </Suspense>
  );
}
