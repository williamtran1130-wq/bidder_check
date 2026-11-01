import React from "react";
import { createRoot } from "react-dom/client";
import { Providers } from "@/components/providers";
import { Shell } from "@/components/shell";
import { Dashboard } from "@/components/dashboard";
import { BidWorkspace } from "@/components/bids";
import { ResumeLibrary } from "@/components/resumes";
import { CandidateProfileLibrary } from "@/components/profiles";
import { People } from "@/components/people";
import { Earnings } from "@/components/earnings";
import { Settings } from "@/components/settings";
import { InterviewReport } from "@/components/interviews";
import { AuthForm } from "@/components/auth-form";
import { BackgroundBeams } from "@/components/ui/background-beams";
import WorkspaceLoading from "@/app/(workspace)/loading";
import { fixture, longWorkspaceName } from "./sample-data";
import { getBidRows } from "./actions";
import { bidReadKey, initialBidQuery } from "@/lib/read-keys";
import { calendarToday } from "@/lib/calendar-period";
import { fetchReportBundle } from "@/lib/report-bundle";
import { readKey } from "@/lib/read-state";
import { workspaceActorScope } from "@/lib/actor-scope";
import "@/app/globals.css";
const parameters = new URLSearchParams(location.search);
const seedQuery = initialBidQuery(parameters.get("review") === "pending");
const seedMode = parameters.get("review") === "pending" ? "all" : "today";
const bidSeed = parameters.has("bid-seed")
  ? {
      key: bidReadKey(
        fixture,
        seedMode,
        "",
        "",
        false,
        undefined,
        seedQuery,
        calendarToday(),
      ),
      result: parameters.has("seed-error")
        ? { error: "Seed results unavailable" }
        : await getBidRows(seedMode, "", "", false, undefined, seedQuery),
    }
  : undefined;
if (bidSeed) document.documentElement.dataset.bidListReads = "0";
const overviewQuery = { period: { preset: "this_week" as const }, workspace: undefined, bidder: undefined, profile: undefined };
const reportSeed = parameters.has("report-seed") ? {
  key: readKey(workspaceActorScope(fixture.profile, fixture.workspaces), "bundle-overview", overviewQuery, calendarToday()),
  result: await fetchReportBundle("overview", overviewQuery),
    receivedAt: Date.now(),
} : undefined;
  if (reportSeed) document.documentElement.dataset.reportSeedAt = String(reportSeed.receivedAt);
window.addEventListener("fixture-change-bid", (event) => {
  const change = (
    event as CustomEvent<{
      id: string;
      patch: Partial<(typeof fixture.bids)[number]>;
    }>
  ).detail;
  fixture.bids = fixture.bids.map((bid) =>
    bid.id === change.id ? { ...bid, ...change.patch } : bid,
  );
});
if (new URLSearchParams(window.location.search).has("screenshot-sizes")) {
  window.addEventListener("fixture-screenshot-change", (event) => {
    const change = (event as CustomEvent<{ id: string; bytes: number }>).detail;
    fixture.bids = fixture.bids.map((bid) =>
      bid.id === change.id
        ? {
            ...bid,
            screenshot_size_bytes: change.bytes,
            version: bid.version + 1,
          }
        : bid,
    );
  });
}
const pages: Record<string, React.ReactNode> = {
  "/loading-workspace": <WorkspaceLoading />,
  "/auth/login": (
    <div className="mx-auto max-w-sm">
      <div className="pointer-events-none relative h-12">
        <BackgroundBeams className="hidden lg:block" />
      </div>
      <h1 className="mb-5 text-2xl">Sign in</h1>
      <AuthForm mode="login" />
    </div>
  ),
  "/dashboard": <Dashboard data={fixture} initial={reportSeed} />,
  "/bids": <BidWorkspace data={fixture} initial={bidSeed} />,
  "/switch-account": <ChangingAccountBids />,
  "/scoped-admin": (
    <BidWorkspace
      data={{ ...fixture, profile: { ...fixture.profile, role: "admin" } }}
      embedded
      bidderId="bidder-0"
    />
  ),
  "/resumes": <ResumeLibrary data={fixture} />,
  "/profiles": <CandidateProfileLibrary data={fixture} />,
  "/users": <People data={fixture} />,
  "/admin-users": (
    <People
      data={{
        ...fixture,
        profile: { ...fixture.profile, id: "admin", role: "admin" },
        profiles: [
          ...fixture.profiles,
          { ...fixture.profile, id: "admin", role: "admin" },
          {
            ...fixture.profiles[1],
            id: "standalone",
            display_name: "Independent Bidder",
            email: "independent@example.test",
          },
          {
            ...fixture.profiles[1],
            id: "archived-standalone",
            display_name: "Archived Independent",
            email: "archived@example.test",
            archived: true,
          },
        ],
        workspaces: [
          ...fixture.workspaces,
          {
            ...fixture.workspaces[0],
            id: "admin-workspace",
            owner_id: "admin",
          },
        ],
        bidders: [
          ...fixture.bidders,
          {
            ...fixture.bidders[0],
            user_id: "standalone",
            workspace_id: "admin-workspace",
          },
          {
            ...fixture.bidders[0],
            user_id: "archived-standalone",
            workspace_id: "admin-workspace",
            archived: true,
          },
        ],
      }}
    />
  ),
  "/earnings": <Earnings />,
  "/settings": <Settings data={fixture} />,
  "/interviews": <InterviewReport />,
};
function ChangingAccountBids() {
  const [data, setData] = React.useState(fixture);
  React.useEffect(() => {
    const change = () => {
      fixture.profile = {
        ...fixture.profiles.find((profile) => profile.id === "bidder-0")!,
        role: "bidder",
      };
      setData({ ...fixture });
    };
    const changeManager = () => {
      fixture.profile = {
        ...fixture.profile,
        id: "replacement-client",
        role: "client",
      };
      setData({ ...fixture });
    };
    window.addEventListener("fixture-change-account", change);
    window.addEventListener("fixture-change-manager", changeManager);
    return () => {
      window.removeEventListener("fixture-change-account", change);
      window.removeEventListener("fixture-change-manager", changeManager);
    };
  }, []);
  return <BidWorkspace data={data} />;
}
const FixtureMode = parameters.has("report-strict") ? React.StrictMode : React.Fragment;
createRoot(document.getElementById("root")!).render(<FixtureMode>
  <Providers>
    <Shell
      profile={fixture.profile}
      workspaces={fixture.workspaces}
      initialCollection={reportSeed?.result.data ? { data: reportSeed.result.data.collection } : undefined}
      workspace={
        new URLSearchParams(window.location.search).has("long-workspace")
          ? longWorkspaceName
          : new URLSearchParams(window.location.search).has("no-workspace")
            ? ""
            : "Northstar Studio"
      }
    >
      {pages[window.location.pathname] ?? pages["/dashboard"]}
    </Shell>
  </Providers></FixtureMode>,
);
