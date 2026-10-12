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
import { Notifications } from "@/components/notifications";
import { InterviewReport } from "@/components/interviews";
import { fixture, longWorkspaceName } from "./sample-data";
import "@/app/globals.css";
if (new URLSearchParams(window.location.search).has("screenshot-sizes")) {
  window.addEventListener("fixture-screenshot-change", (event) => {
    const change = (event as CustomEvent<{ id: string; bytes: number }>).detail;
    fixture.bids = fixture.bids.map((bid) => bid.id === change.id ? { ...bid, screenshot_size_bytes: change.bytes, version: bid.version + 1 } : bid);
  });
}
const pages: Record<string, React.ReactNode> = {
  "/dashboard": <Dashboard data={fixture} />,
  "/bids": <BidWorkspace data={fixture} />,
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
  "/admin-notifications": <Notifications data={{ ...fixture, profile: { ...fixture.profile, role: "admin" } }} initialInbox={[]} initialMessages={[]} />,
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
  "/notifications": <Notifications data={fixture} initialInbox={[]} initialMessages={[]} />,
  "/interviews": <InterviewReport />,
};
createRoot(document.getElementById("root")!).render(
  <Providers>
    <Shell profile={fixture.profile} workspace={new URLSearchParams(window.location.search).has("long-workspace") ? longWorkspaceName : new URLSearchParams(window.location.search).has("no-workspace") ? "" : "Northstar Studio"}>
      {pages[window.location.pathname] ?? pages["/dashboard"]}
    </Shell>
  </Providers>,
);
