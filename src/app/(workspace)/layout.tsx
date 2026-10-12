import { getContext } from "@/lib/auth";
import { Shell } from "@/components/shell";
export const dynamic = "force-dynamic";
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { profile, workspaces } = await getContext();
  return (
    <Shell
      profile={profile}
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
