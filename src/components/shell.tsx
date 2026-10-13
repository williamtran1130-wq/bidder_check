"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useTheme } from "next-themes";
import {
  LayoutDashboard,
  Users,
  FileText,
  ContactRound,
  BriefcaseBusiness,
  Wallet,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  Moon,
  Sun,
  Menu,
  ArrowUpRight,
  ChevronRight,
  ShieldCheck,
  MessageSquareText,
  ChartNoAxesCombined,
  Bell,
} from "lucide-react";
import { Brand } from "./brand";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "./ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { signOut } from "@/app/auth/actions";
import { getNotificationUnreadCount } from "@/app/(workspace)/notification-actions";
import {
  useNotificationResource,
  useNotificationScope,
} from "@/lib/use-notifications";
import {
  notificationScope,
  type NotificationMembership,
} from "@/lib/notification-scope";
import { initials } from "@/lib/domain";
import { cn } from "@/lib/utils";
import type { Row } from "@/lib/database.types";
const links = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/bids", label: "Bids", icon: BriefcaseBusiness },
  { href: "/resumes", label: "Resumes", icon: FileText },
  { href: "/profiles", label: "Profiles", icon: ContactRound },
  { href: "/users", label: "People", icon: Users },
  { href: "/earnings", label: "Earnings", icon: Wallet },
  {
    href: "/interviews",
    label: "Interviews",
    icon: ChartNoAxesCombined,
  },
  { href: "/notifications", label: "Notifications", icon: MessageSquareText },
];
export function Shell({
  children,
  profile,
  workspace,
  unreadCount = 0,
  notificationWorkspaces = [],
}: {
  children: React.ReactNode;
  profile: Row<"profiles">;
  workspace: string;
  unreadCount?: number;
  notificationWorkspaces?: NotificationMembership[];
}) {
  const pathname = usePathname();
  const workspaceName = workspace.trim() || "Workspace";
  const workspaceAvatarName = workspace.startsWith("Workspace - ")
    ? workspace.slice("Workspace - ".length).trim() || "Workspace"
    : workspaceName;
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const notificationKey = notificationScope(profile, notificationWorkspaces);
  const allowInitial = useNotificationScope(notificationKey);
  const unreadResult = useNotificationResource(
    `${notificationKey}unread`,
    getNotificationUnreadCount,
    allowInitial ? { data: unreadCount } : {},
  );
  const unread = unreadResult.data ?? (allowInitial ? unreadCount : 0);
  const { resolvedTheme, setTheme } = useTheme();
  const nav = (small = false) => (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <Link href="/dashboard" className="px-5 py-7">
        <Brand compact={small} />
      </Link>
      <div
        className={cn(
          "mx-4 mb-8 flex items-center gap-3 rounded-lg border bg-background p-3",
          small && "justify-center px-1",
        )}
      >
        {small ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={workspaceName}
                className="flex size-8 shrink-0 items-center justify-center rounded-md bg-violet-100 text-xs font-bold text-violet-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {initials(workspaceAvatarName)}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-xs break-words">
              {workspaceName}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-violet-100 text-xs font-bold text-violet-700">
            {initials(workspaceAvatarName)}
          </span>
        )}
        {!small && (
          <div className="min-w-0">
            <p className="break-words text-xs font-semibold leading-5">
              {workspaceName}
            </p>
            <p className="mt-1 text-[10px] capitalize text-muted-foreground">
              {profile.role} workspace
            </p>
          </div>
        )}
      </div>
      {!small && <p className="eyebrow px-6 pb-3">WORKSPACE</p>}
      <nav className="space-y-1 px-3">
        {links
          .filter(
            (l) =>
              (l.href !== "/users" &&
                l.href !== "/profiles" &&
                l.href !== "/earnings") ||
              profile.role !== "bidder",
          )
          .map((l) => (
            <Link
              title={l.label}
              onClick={() => setMobile(false)}
              key={l.href}
              href={l.href}
              className={cn(
                "flex h-11 items-center gap-3 rounded-lg px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                pathname.startsWith(l.href) &&
                  "bg-accent text-primary hover:bg-accent hover:text-primary",
                small && "justify-center px-0",
              )}
            >
              <l.icon size={18} />
              {!small && l.label}
              {!small && pathname.startsWith(l.href) && (
                <span className="ml-auto size-1.5 rounded-full bg-primary" />
              )}
            </Link>
          ))}
      </nav>
      <div className="mt-auto p-3">
        {!small && (
          <div className="mb-5 rounded-xl bg-gradient-to-br from-violet-50 to-indigo-50 p-4 dark:from-violet-950/30 dark:to-indigo-950/30">
            <ShieldCheck size={19} className="mb-2 text-primary" />
            <p className="text-xs font-semibold">Your work. Your space.</p>
            <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
              Everything your team needs, safely in one place.
            </p>
          </div>
        )}
        <Link
          title="Settings"
          href="/settings"
          className={cn(
            "flex h-11 items-center gap-3 rounded-lg px-3 text-muted-foreground hover:bg-secondary",
            small && "justify-center",
          )}
        >
          <Settings size={18} />
          {!small && "Settings"}
        </Link>
        <form action={signOut}>
          <button
            title="Sign out"
            className={cn(
              "flex h-11 w-full items-center gap-3 rounded-lg px-3 text-muted-foreground hover:bg-secondary",
              small && "justify-center",
            )}
          >
            <LogOut size={18} />
            {!small && "Sign out"}
          </button>
        </form>
      </div>
    </div>
  );
  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only z-50 focus:not-sr-only focus:fixed focus:bg-card focus:p-4"
      >
        Skip to content
      </a>
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 hidden border-r bg-card transition-[width] lg:block",
          collapsed ? "w-20" : "w-60",
        )}
      >
        {nav(collapsed)}
      </aside>
      <div
        className={cn(
          "min-w-0 flex-1 transition-[padding]",
          collapsed ? "lg:pl-20" : "lg:pl-60",
        )}
      >
        <header className="flex h-[76px] items-center gap-4 border-b bg-card px-5 sm:px-9">
          <Sheet open={mobile} onOpenChange={setMobile}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label="Open navigation"
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              {nav()}
            </SheetContent>
          </Sheet>
          <Button
            variant="ghost"
            size="icon"
            className="hidden text-muted-foreground lg:inline-flex"
            onClick={() => setCollapsed(!collapsed)}
            aria-label="Toggle sidebar"
          >
            {collapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <PanelLeftClose size={18} />
            )}
          </Button>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="hidden sm:inline">Workspace</span>
            <ChevronRight size={12} className="hidden sm:block" />
            <span className="font-medium text-foreground">
              {links.find((l) => pathname.startsWith(l.href))?.label ??
                "Settings"}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {profile.role !== "client" && (
              <Link
                href="/notifications"
                aria-label={
                  unreadResult.error
                    ? "Unread notifications unavailable"
                    : `${unread} unread notifications`
                }
                className="relative rounded-md p-2 text-muted-foreground hover:bg-secondary"
              >
                <Bell size={17} />
                {unread > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground">
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </Link>
            )}
            <span className="hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] text-muted-foreground sm:flex">
              <span className="size-1.5 rounded-full bg-emerald-500" /> Private
              workspace
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle color theme"
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              <Sun className="hidden size-4 dark:block" />
              <Moon className="size-4 dark:hidden" />
            </Button>
            <span className="h-7 border-l" />
            <Link href="/settings" className="flex items-center gap-2.5">
              <span className="flex size-9 items-center justify-center rounded-full bg-[#f2e6dc] text-xs font-bold text-[#795539]">
                {initials(profile.display_name || profile.email)}
              </span>
              <span className="hidden sm:block">
                <span className="block text-xs font-semibold">
                  {profile.display_name || "Your account"}
                </span>
                <span className="mt-0.5 block text-[10px] capitalize text-muted-foreground">
                  {profile.role}
                </span>
              </span>
            </Link>
          </div>
        </header>
        <main
          id="main"
          className="page-enter mx-auto max-w-[1600px] p-5 sm:p-9"
        >
          {children}
        </main>
        <footer className="mx-5 flex justify-between border-t py-5 text-[10px] text-muted-foreground sm:mx-9">
          <span>© {new Date().getFullYear()} Bidder Check</span>
          <span className="flex items-center gap-1">
            A clearer way to work <ArrowUpRight size={12} />
          </span>
        </footer>
      </div>
    </div>
  );
}
