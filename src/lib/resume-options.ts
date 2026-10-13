import type { WorkspaceData } from "./data";

export type ResumeOption = {
  id: string;
  bidderId: string;
  groupId: string;
  primary: string;
  secondary: string;
  label: string;
  archived: boolean;
};

// Labels describe an assignment, not a PDF version. Never use copied profile names.
export function buildResumeOptions(data: Pick<WorkspaceData, "profile" | "resumes" | "candidateProfiles" | "profiles" | "workspaces">): Map<string, ResumeOption> {
  const profiles = new Map(data.candidateProfiles.map((profile) => [profile.id, profile]));
  const people = new Map(data.profiles.map((profile) => [profile.id, profile]));
  const workspaces = new Map(data.workspaces.map((workspace) => [workspace.id, workspace.name]));
  const entries = data.resumes.map((resume) => {
    const profile = profiles.get(resume.profile_id ?? "");
    const primary = [profile?.identifier || "Profile", profile?.candidate_name || "Unnamed candidate"].join(" · ");
    const secondary = [people.get(resume.bidder_id)?.display_name || "Bidder", resume.email || "No assignment email"].join(" · ");
    return { resume, primary, secondary, base: `${primary} — ${secondary}` };
  });
  const contexts = new Map<string, Set<string>>();
  for (const { base, resume } of entries) {
    if (!contexts.has(base)) contexts.set(base, new Set());
    contexts.get(base)!.add(resume.workspace_id);
  }
  const labels = entries.map((entry) => {
    const workspace = data.profile.role === "admin" && contexts.get(entry.base)!.size > 1
      ? workspaces.get(entry.resume.workspace_id) || "Workspace" : "";
    return { ...entry, secondary: entry.secondary + (workspace ? ` · ${workspace}` : ""), base: entry.base + (workspace ? ` · ${workspace}` : "") };
  });
  const collisions = new Map<string, string[]>();
  for (const { base, resume } of labels) {
    if (!collisions.has(base)) collisions.set(base, []);
    collisions.get(base)!.push(resume.id);
  }
  return new Map(labels.map(({ resume, primary, secondary, base }) => {
    const peers = collisions.get(base)!;
    let suffix = "";
    if (peers.length > 1) {
      let length = Math.min(8, resume.id.length);
      while (length < resume.id.length && peers.some((id) => id !== resume.id && id.slice(0, length) === resume.id.slice(0, length))) length++;
      suffix = ` · ${resume.id.slice(0, length)}`;
    }
    const archived = resume.archived || !!profiles.get(resume.profile_id ?? "")?.archived || !!people.get(resume.bidder_id)?.archived;
    const detail = secondary + suffix + (archived ? " · Archived" : "");
    return [resume.id, { id: resume.id, bidderId: resume.bidder_id, groupId: resume.profile_id ?? resume.id, primary, secondary: detail, label: `${primary} — ${detail}`, archived }];
  }));
}

export function filterResumeOptions(options: ResumeOption[], search: string, bidder = "all") {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return options.filter((option) => (bidder === "all" || option.bidderId === bidder) && terms.every((term) => option.label.toLocaleLowerCase().includes(term)));
}

export function compatibleResume(options: ResumeOption[], selected: string, bidder: string) {
  return options.some((option) => option.id === selected && (bidder === "all" || option.bidderId === bidder)) ? selected : "all";
}
