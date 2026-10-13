import type { WorkspaceData } from "./data";
import type { BidListQuery } from "./bid-list";
import { notificationScope } from "./notification-scope";
import { readKey } from "./read-state";
export const actorReadScope = (
  data: Pick<WorkspaceData, "profile" | "workspaces">,
) => notificationScope(data.profile, data.workspaces);
export function bidReadKey(
  data: Pick<WorkspaceData, "profile" | "workspaces">,
  mode: string,
  from: string,
  to: string,
  trash: boolean,
  bidderId: string | undefined,
  query: BidListQuery,
  day: string,
) {
  return readKey(
    actorReadScope(data),
    "bids",
    [mode, from, to, trash, bidderId ?? null, query],
    day,
  );
}
export function initialBidQuery(
  review = false,
  bidderId?: string,
): BidListQuery {
  return {
    search: "",
    status: review ? "pending_review" : "all",
    arrangement: "all",
    resume: "all",
    bidder: bidderId ?? "all",
    source: "all",
    job: "all",
    columnFilters: [],
    sorting: [{ id: "found_at", desc: true }],
    pageIndex: 0,
    pageSize: 10,
  };
}
