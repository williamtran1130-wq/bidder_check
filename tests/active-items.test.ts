import { describe, expect, it } from "vitest";
import { activeBidders, activeCandidateProfiles, activeResumes, activeWorkspaces } from "../src/lib/active-items";

function fixture() {
  return {
    profile: { id: "owner", archived: false, role: "client" },
    profiles: [{ id: "bidder", archived: false, role: "bidder" }],
    workspaces: [{ id: "workspace", owner_id: "owner", name: "Workspace" }],
    bidders: [{ user_id: "bidder", workspace_id: "workspace", archived: false, rate: 125 }],
    candidateProfiles: [{ id: "candidate", workspace_id: "workspace", archived: false, identifier: "ENG" }],
    resumes: [{ id: "resume", workspace_id: "workspace", bidder_id: "bidder", profile_id: "candidate", archived: false, email: "test@example.test" }],
  };
}

describe("active UI collections", () => {
  it("preserves full row fields and accepts bidder actors as their own account", () => {
    const data = fixture();
    expect(activeBidders(data)[0].rate).toBe(125);
    expect(activeCandidateProfiles(data)[0].identifier).toBe("ENG");
    expect(activeResumes(data)[0].email).toBe("test@example.test");
    data.profile = { id: "bidder", archived: false, role: "bidder" };
    data.profiles = [];
    expect(activeBidders(data).map((b) => b.user_id)).toEqual(["bidder"]);
  });
  it.each(["archived account", "removed account", "archived membership", "removed membership", "role change", "missing workspace", "archived owner", "archived candidate", "removed candidate", "archived resume", "candidate workspace mismatch", "membership workspace mismatch"])("hides assignments with %s", (change) => {
    const data = fixture();
    if (change === "archived account") data.profiles[0].archived = true;
    if (change === "removed account") data.profiles = [];
    if (change === "archived membership") data.bidders[0].archived = true;
    if (change === "removed membership") data.bidders = [];
    if (change === "role change") data.profiles[0].role = "client";
    if (change === "missing workspace") data.workspaces = [];
    if (change === "archived owner") data.profile.archived = true;
    if (change === "archived candidate") data.candidateProfiles[0].archived = true;
    if (change === "removed candidate") data.candidateProfiles = [];
    if (change === "archived resume") data.resumes[0].archived = true;
    if (change === "candidate workspace mismatch") data.candidateProfiles[0].workspace_id = "other";
    if (change === "membership workspace mismatch") data.bidders[0].workspace_id = "other";
    expect(activeResumes(data)).toEqual([]);
  });
  it("hides archived-owner workspaces and their candidates, but trusts visible workspaces when owner metadata is absent", () => {
    const data = fixture();
    data.profile.archived = true;
    expect(activeWorkspaces(data)).toEqual([]);
    expect(activeCandidateProfiles(data)).toEqual([]);
    data.workspaces[0].owner_id = "rls-hidden-owner";
    expect(activeWorkspaces(data).map((w) => w.name)).toEqual(["Workspace"]);
    expect(activeCandidateProfiles(data).map((p) => p.id)).toEqual(["candidate"]);
  });
  it("honors server-supplied selectable workspace IDs when owner metadata is hidden", () => {
    const data = { ...fixture(), selectableWorkspaces: [] as { id: string }[] };
    data.workspaces[0].owner_id = "rls-hidden-owner";
    expect(activeWorkspaces(data)).toEqual([]);
    expect(activeBidders(data)).toEqual([]);
    expect(activeCandidateProfiles(data)).toEqual([]);
    expect(activeResumes(data)).toEqual([]);
    data.selectableWorkspaces = [{ id: "workspace" }];
    expect(activeWorkspaces(data).map((w) => w.id)).toEqual(["workspace"]);
  });
});
