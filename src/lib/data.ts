import "server-only";
import { getContext } from "./auth";
import type { Row } from "./database.types";
import {
  SAFE_BIDDER_COLUMNS,
  SAFE_RESUME_COLUMNS,
  type BidderRow,
  type ResumeRow,
  type BidRow,
} from "./workspace-types";
import { getManagerFinancialValues } from "./financial-data";
type LoadableTable =
  "profiles" | "bidders" | "resumes" | "candidate_profiles" | "invitations";
type LoadedRow<T extends LoadableTable> = T extends "bidders"
  ? BidderRow
  : T extends "resumes"
    ? ResumeRow
    : Row<T>;
export type WorkspaceData = {
  profile: Row<"profiles">;
  workspaces: Row<"workspaces">[];
  profiles: Row<"profiles">[];
  bidders: BidderRow[];
  resumes: ResumeRow[];
  candidateProfiles: Row<"candidate_profiles">[];
  historicalAggregates: Row<"retained_bid_daily_aggregates">[];
  bids: BidRow[];
  bidCounts: Record<string, number>;
  invitations: Row<"invitations">[];
};
export async function getWorkspaceData(
  options: {
    includeBidCounts?: boolean;
    scope?:
      | "full"
      | "settings"
      | "people"
      | "profiles"
      | "resumes"
      | "notifications"
      | "dashboard"
      | "bids"
      | "bidder-detail";
    bidderId?: string;
  } = {},
): Promise<WorkspaceData> {
  const { supabase, profile, workspaces } = await getContext();
  const scope = options.scope ?? "full";
  const needsProfiles = [
    "full",
    "people",
    "profiles",
    "resumes",
    "notifications",
    "dashboard",
    "bids",
    "bidder-detail",
  ].includes(scope);
  const needsBidders = [
    "full",
    "people",
    "profiles",
    "resumes",
    "notifications",
    "dashboard",
    "bids",
    "bidder-detail",
  ].includes(scope);
  const needsResumes = [
    "full",
    "profiles",
    "resumes",
    "bids",
    "bidder-detail",
  ].includes(scope);
  const needsCandidateProfiles = [
    "full",
    "profiles",
    "resumes",
    "dashboard",
    "bids",
    "bidder-detail",
  ].includes(scope);
  const needsInvitations =
    ["full", "people"].includes(scope) && profile.role !== "bidder";
  async function all<
    T extends
      "profiles" | "bidders" | "resumes" | "candidate_profiles" | "invitations",
  >(
    table: T,
    filter?: { column: string; value: string },
  ): Promise<LoadedRow<T>[]> {
    const result: LoadedRow<T>[] = [];
    for (let start = 0; ; start += 1000) {
      let query = supabase
        .from(table)
        .select(
          table === "bidders"
            ? SAFE_BIDDER_COLUMNS
            : table === "resumes"
              ? SAFE_RESUME_COLUMNS
              : "*",
        );
      if (filter) query = query.eq(filter.column as never, filter.value);
      query = query.order(table === "bidders" ? "user_id" : "id");
      query = query.range(start, start + 999);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      result.push(...(data as unknown as LoadedRow<T>[]));
      if (data.length < 1000) break;
    }
    return result;
  }
  const bidderFilter =
    scope === "bidder-detail" && options.bidderId
      ? { column: "user_id", value: options.bidderId }
      : undefined;
  const biddersPromise = needsBidders
    ? all("bidders", bidderFilter)
    : Promise.resolve([]);
  const resumesPromise: Promise<ResumeRow[]> = needsResumes
    ? all(
        "resumes",
        scope === "bidder-detail" && options.bidderId
          ? { column: "bidder_id", value: options.bidderId }
          : undefined,
      )
    : Promise.resolve([]);
  const candidateProfilesPromise: Promise<Row<"candidate_profiles">[]> =
    needsCandidateProfiles && scope === "bidder-detail" && options.bidderId
      ? biddersPromise.then(async (memberships) => {
          const membership = memberships.find(
            (item) => item.user_id === options.bidderId,
          );
          return membership
            ? all("candidate_profiles", {
                column: "workspace_id",
                value: membership.workspace_id,
              })
            : [];
        })
      : needsCandidateProfiles
        ? all("candidate_profiles")
        : Promise.resolve([]);
  const [
    profiles,
    bidders,
    resumes,
    candidateProfiles,
    bidCountsResult,
    invitations,
  ] = await Promise.all([
    needsProfiles
      ? all(
          "profiles",
          scope === "bidder-detail" && options.bidderId
            ? { column: "id", value: options.bidderId }
            : undefined,
        )
      : Promise.resolve([]),
    biddersPromise,
    resumesPromise,
    candidateProfilesPromise,
    options.includeBidCounts &&
    scope === "bidder-detail" &&
    options.bidderId &&
    profile.role !== "bidder"
      ? supabase.rpc("resume_bid_counts_for_bidder", {
          p_bidder: options.bidderId,
        })
      : options.includeBidCounts
        ? supabase.rpc("resume_bid_counts")
        : Promise.resolve({ data: {}, error: null }),
    needsInvitations ? all("invitations") : Promise.resolve([]),
  ]);
  if (bidCountsResult.error) throw new Error(bidCountsResult.error.message);
  const bidCounts = (bidCountsResult.data ?? {}) as Record<string, number>;
  const safeBidders: BidderRow[] = bidders;
  const safeResumes: ResumeRow[] = resumes;
  if (
    profile.role !== "bidder" &&
    ["full", "people", "profiles", "resumes", "bidder-detail"].includes(scope)
  ) {
    const values = await getManagerFinancialValues(supabase, {
      bidderIds: bidders.map((item) => item.user_id),
      resumeIds: resumes.map((item) => item.id),
    });
    for (const item of safeBidders)
      item.default_rate_cents = values.bidders[item.user_id] ?? null;
    for (const item of safeResumes)
      item.rate_override_cents = values.resumes[item.id] ?? null;
  }
  return {
    profile,
    workspaces,
    profiles,
    bidders: safeBidders,
    resumes: safeResumes,
    candidateProfiles,
    historicalAggregates: [],
    bids: [],
    bidCounts,
    invitations,
  };
}

/** Dashboard filters need labels and membership, never assignment/contact/rule payloads. */
export type DashboardData = Pick<WorkspaceData, "profile" | "workspaces"> & {
  profiles: Pick<Row<"profiles">, "id" | "display_name">[];
  bidders: Pick<BidderRow, "user_id" | "workspace_id" | "archived">[];
  candidateProfiles: Pick<
    Row<"candidate_profiles">,
    "id" | "workspace_id" | "identifier" | "archived"
  >[];
};
export async function getDashboardData(): Promise<DashboardData> {
  const { supabase, profile, workspaces } = await getContext();
  // Each reader retains its concrete projection type; never cast a partial row to a full DTO.
  async function people() {
    const rows: DashboardData["profiles"] = [];
    for (let offset = 0; ; offset += 1000) {
      const result = await supabase
        .from("profiles")
        .select("id,display_name")
        .order("id")
        .range(offset, offset + 999);
      if (result.error) throw result.error;
      rows.push(...result.data);
      if (result.data.length < 1000) return rows;
    }
  }
  async function bidders() {
    const rows: DashboardData["bidders"] = [];
    for (let offset = 0; ; offset += 1000) {
      const result = await supabase
        .from("bidders")
        .select(SAFE_BIDDER_COLUMNS)
        .order("user_id")
        .range(offset, offset + 999);
      if (result.error) throw result.error;
      rows.push(...result.data);
      if (result.data.length < 1000) return rows;
    }
  }
  async function candidates() {
    const rows: DashboardData["candidateProfiles"] = [];
    for (let offset = 0; ; offset += 1000) {
      const result = await supabase
        .from("candidate_profiles")
        .select("id,workspace_id,identifier,archived")
        .order("id")
        .range(offset, offset + 999);
      if (result.error) throw result.error;
      rows.push(...result.data);
      if (result.data.length < 1000) return rows;
    }
  }
  const [profiles, memberships, candidateProfiles] = await Promise.all([
    people(),
    bidders(),
    candidates(),
  ]);
  return {
    profile,
    workspaces,
    profiles,
    bidders: memberships,
    candidateProfiles,
  };
}
