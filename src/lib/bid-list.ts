import type { SortingState, ColumnFiltersState } from "@tanstack/react-table";
import type { BidRow } from "./workspace-types";

export const BID_LIST_RPC = "list_bids_v2" as const;

export type BidListQuery = {
  search: string;
  status: string;
  arrangement: string;
  resume: string;
  bidder: string;
  source: string;
  job: string;
  columnFilters: ColumnFiltersState;
  sorting: SortingState;
  pageIndex: number;
  pageSize: number;
};

export type BidListResult = {
  rows: BidRow[];
  total: number;
  sources: string[];
  statusCounts: Record<string, number>;
};

export type BidListLoadResult =
  | { data: BidListResult; error?: never; code?: never }
  | {
      data?: never;
      error: string;
      code?: "statement_timeout";
    };
