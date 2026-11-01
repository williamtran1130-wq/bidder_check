/** Minimal structural inputs let full workspace rows and narrow dashboard rows share these rules. */
export type AccountReference = { id: string; archived: boolean; role?: string };
export type WorkspaceReference = { id: string; owner_id?: string };
export type BidderReference = { user_id: string; workspace_id: string; archived: boolean };
export type CandidateReference = { id: string; workspace_id: string; archived: boolean };
export type ResumeReference = { id: string; workspace_id: string; bidder_id: string; profile_id: string | null; archived: boolean };
type Accounts = { profile: AccountReference; profiles: readonly AccountReference[]; selectableWorkspaces?: readonly { id: string }[] };
type WorkspaceContext = Accounts & { workspaces: readonly WorkspaceReference[] };

function accounts(data: Accounts) {
  return new Map([...data.profiles, data.profile].map((person) => [person.id, person]));
}

/** An authorized workspace may have its owner's account hidden by RLS. */
export function activeWorkspaces<W extends WorkspaceReference>(data: Accounts & { workspaces: readonly W[] }): W[] {
  const people = accounts(data);
  const selectable = data.selectableWorkspaces === undefined ? undefined : new Set(data.selectableWorkspaces.map((workspace) => workspace.id));
  return data.workspaces.filter((workspace) => (!selectable || selectable.has(workspace.id)) && !people.get(workspace.owner_id ?? "")?.archived);
}

export function activeBidders<B extends BidderReference>(data: WorkspaceContext & { bidders: readonly B[] }): B[] {
  const people = accounts(data);
  const workspaces = new Set(activeWorkspaces(data).map((workspace) => workspace.id));
  return data.bidders.filter((bidder) => {
    const person = people.get(bidder.user_id);
    return !bidder.archived && !!person && !person.archived &&
      (person.role === undefined || person.role === "bidder") && workspaces.has(bidder.workspace_id);
  });
}

export function activeCandidateProfiles<P extends CandidateReference>(data: WorkspaceContext & { candidateProfiles: readonly P[] }): P[] {
  const workspaces = new Set(activeWorkspaces(data).map((workspace) => workspace.id));
  return data.candidateProfiles.filter((profile) => !profile.archived && workspaces.has(profile.workspace_id));
}

export function activeResumes<R extends ResumeReference>(data: WorkspaceContext & {
  bidders: readonly BidderReference[]; candidateProfiles: readonly CandidateReference[]; resumes: readonly R[];
}): R[] {
  const candidates = new Map(activeCandidateProfiles(data).map((profile) => [profile.id, profile]));
  const memberships = new Set(activeBidders(data).map((bidder) => JSON.stringify([bidder.user_id, bidder.workspace_id])));
  return data.resumes.filter((resume) => !resume.archived &&
    candidates.get(resume.profile_id ?? "")?.workspace_id === resume.workspace_id &&
    memberships.has(JSON.stringify([resume.bidder_id, resume.workspace_id])));
}
