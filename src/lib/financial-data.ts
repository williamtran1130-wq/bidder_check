import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
export type FinancialValues = {
  bidders: Record<string, number | null>;
  resumes: Record<string, number | null>;
  bids: Record<string, number | null>;
};
export async function getManagerFinancialValues(
  supabase: SupabaseClient<Database>,
  ids: { bidderIds?: string[]; resumeIds?: string[]; bidIds?: string[] },
): Promise<FinancialValues> {
  const result: FinancialValues = { bidders: {}, resumes: {}, bids: {} };
  const requested = [...new Set(ids.bidderIds ?? [])].map((id) => ({
    kind: "bidders" as const,
    id,
  }));
  const all = [
    ...requested,
    ...[...new Set(ids.resumeIds ?? [])].map((id) => ({
      kind: "resumes" as const,
      id,
    })),
    ...[...new Set(ids.bidIds ?? [])].map((id) => ({
      kind: "bids" as const,
      id,
    })),
  ];
  for (let start = 0; start < all.length; start += 1000) {
    const chunk = all.slice(start, start + 1000);
    const { data, error } = await supabase.rpc("manager_financial_values", {
      p_bidder_ids: chunk
        .filter((item) => item.kind === "bidders")
        .map((item) => item.id),
      p_resume_ids: chunk
        .filter((item) => item.kind === "resumes")
        .map((item) => item.id),
      p_bid_ids: chunk
        .filter((item) => item.kind === "bids")
        .map((item) => item.id),
    });
    if (error) throw new Error(error.message);
    const values = data as FinancialValues;
    for (const key of ["bidders", "resumes", "bids"] as const)
      Object.assign(result[key], values[key]);
  }
  return result;
}
