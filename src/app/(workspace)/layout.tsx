import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { getContext } from "@/lib/auth";
import { readCollectionStatus } from "@/lib/report-bundle-server";
import { Shell } from "@/components/shell";
export const dynamic = "force-dynamic";
async function Content({ children }: { children: React.ReactNode }) {
  const { profile, workspaces } = await getContext();
  const initialCollection = await readCollectionStatus(workspaces[0]?.id);
  return (
    <Shell
      profile={profile}
      workspaces={workspaces}
      initialCollection={initialCollection}
      collectionReceivedAt={initialCollection.receivedAt}
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
