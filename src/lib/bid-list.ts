import type { SortingState, ColumnFiltersState } from "@tanstack/react-table";
import type { BidRow } from "./workspace-types";
import type { ApplicationLocation } from "./upload-context-types";

export const BID_LIST_RPC = "list_bids_v2" as const;

export type BidListQuery = {
  ipCountry?: string;
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
  rows: (BidRow & { applicationLocation: ApplicationLocation | null })[];
  total: number;
  sources: string[];
  countryOptions: string[];
  statusCounts: Record<string, number>;
};

export type BidListLoadResult =
  | { data: BidListResult; error?: never; code?: never }
  | {
      data?: never;
      error: string;
      code?: "statement_timeout";
    };
