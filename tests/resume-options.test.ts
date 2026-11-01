import { describe, expect, it, vi } from "vitest";
import { buildResumeOptions, filterResumeOptions, compatibleResume } from "../src/lib/resume-options";
import { fixture } from "./preview/sample-data";
vi.hoisted(() => { vi.stubGlobal("window", { location: { search: "" } }); });

describe("resume assignment choices", () => {
  it("uses canonical profiles and distinguishes assignments by bidder and email", () => {
    const data = structuredClone(fixture);
    data.resumes[1].profile_id = data.resumes[0].profile_id;
    data.candidateProfiles[0].candidate_name = "Renamed Candidate";
    const choices = buildResumeOptions(data);
    expect(choices.get("resume-0")?.label).toBe("ENG-01 · Renamed Candidate — Jamie Parker · bidder0@example.test");
    expect(choices.get("resume-1")?.label).toContain("Taylor Reed · bidder1@example.test");
    expect(choices.get("resume-0")?.groupId).toBe(choices.get("resume-1")?.groupId);
  });
  it("adds workspace context only for admin collisions and stable ID suffixes when still ambiguous", () => {
    const data = structuredClone(fixture);
    data.profile.role = "admin";
    data.workspaces.push({ ...data.workspaces[0], id: "workspace-b", name: "Other workspace" });
    data.candidateProfiles.push({ ...data.candidateProfiles[0], id: "profile-b", workspace_id: "workspace-b" });
    data.resumes.push({ ...data.resumes[0], id: "abcdefgh-1", workspace_id: "workspace-b", profile_id: "profile-b" });
    let options = buildResumeOptions(data);
    expect(options.get("resume-0")?.label).toContain("Northstar Studio");
    expect(options.get("abcdefgh-1")?.label).toContain("Other workspace");
    data.resumes.push({ ...data.resumes.at(-1)!, id: "abcdefgh-2" });
    options = buildResumeOptions(data);
    expect(options.get("abcdefgh-1")?.label).not.toBe(options.get("abcdefgh-2")?.label);
    expect(options.get("resume-2")?.label).not.toContain("Northstar Studio");
  });
  it("keeps historical labels but excludes archived assignments from search and selection", () => {
    const data = structuredClone(fixture);
    data.resumes = Array.from({ length: 1205 }, (_, i) => ({ ...data.resumes[0], id: `assignment-${i}`, email: `person${i}@example.test`, archived: i === 1204 }));
    const options = [...buildResumeOptions(data).values()];
    expect(filterResumeOptions(options, "person1204")).toHaveLength(0);
    expect(options.at(-1)?.label).toContain("Archived");
    expect(compatibleResume(options, "assignment-1204", "bidder-0")).toBe("all");
    expect(compatibleResume(options, "assignment-1203", "bidder-0")).toBe("assignment-1203");
    expect(compatibleResume(options, "assignment-1204", "bidder-1")).toBe("all");
    expect(compatibleResume(options, "missing", "all")).toBe("all");
    expect(filterResumeOptions(options, "PERSON1203")).toHaveLength(1);
  });
  it("labels historical assignments of archived bidders", () => {
    const data = structuredClone(fixture);
    data.profiles.find((profile) => profile.id === "bidder-0")!.archived = true;
    expect(buildResumeOptions(data).get("resume-0")?.label).toContain("Archived");
  });
  it.each(["account", "membership", "candidate", "workspace"])("does not offer assignments with a removed %s", (ancestor) => {
    const data = structuredClone(fixture);
    if (ancestor === "account") data.profiles = data.profiles.filter((p) => p.id !== "bidder-0");
    if (ancestor === "membership") data.bidders = data.bidders.filter((p) => p.user_id !== "bidder-0");
    if (ancestor === "candidate") data.candidateProfiles = data.candidateProfiles.filter((p) => p.id !== data.resumes[0].profile_id);
    if (ancestor === "workspace") data.workspaces = [];
    const labels = buildResumeOptions(data);
    expect(labels.has("resume-0")).toBe(true);
    expect(filterResumeOptions([...labels.values()], "bidder0@example.test")).toEqual([]);
  });
});
