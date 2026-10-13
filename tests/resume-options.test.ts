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
  it("searches all loaded assignments, including archived, and preserves compatible UUID selections", () => {
    const data = structuredClone(fixture);
    data.resumes = Array.from({ length: 1205 }, (_, i) => ({ ...data.resumes[0], id: `assignment-${i}`, email: `person${i}@example.test`, archived: i === 1204 }));
    const options = [...buildResumeOptions(data).values()];
    expect(filterResumeOptions(options, "person1204")).toHaveLength(1);
    expect(filterResumeOptions(options, "person1204")[0].label).toContain("Archived");
    expect(compatibleResume(options, "assignment-1204", "bidder-0")).toBe("assignment-1204");
    expect(compatibleResume(options, "assignment-1204", "bidder-1")).toBe("all");
    expect(compatibleResume(options, "missing", "all")).toBe("all");
    expect(filterResumeOptions(options, "PERSON1204")).toHaveLength(1);
  });
  it("labels historical assignments of archived bidders", () => {
    const data = structuredClone(fixture);
    data.profiles.find((profile) => profile.id === "bidder-0")!.archived = true;
    expect(buildResumeOptions(data).get("resume-0")?.label).toContain("Archived");
  });
});
