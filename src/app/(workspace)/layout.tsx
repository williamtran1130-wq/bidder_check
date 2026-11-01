import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { getContext } from "@/lib/auth";
import { readCollectionStatus } from "@/lib/report-bundle-server";
import { Shell } from "@/components/shell";
export const dynamic = "force-dynamic";
async function Content({ children }: { children: React.ReactNode }) {
  const { profile, workspaces, selectableWorkspaces } = await getContext();
  const visibleWorkspaces = selectableWorkspaces ?? workspaces;
  const initialCollection: Awaited<ReturnType<typeof readCollectionStatus>> = visibleWorkspaces.length
    ? await readCollectionStatus(visibleWorkspaces[0]?.id)
    : { data: { status: "not_synced", updatedAt: null, from: null, to: null } };
  return (
    <Shell
      profile={profile}
      workspaces={workspaces}
      collectionWorkspaces={visibleWorkspaces}
      initialCollection={initialCollection}
      collectionReceivedAt={initialCollection.receivedAt}
      workspace={
        profile.role === "admin"
          ? "Platform overview"
          : (visibleWorkspaces[0]?.name ?? "Workspace")
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
