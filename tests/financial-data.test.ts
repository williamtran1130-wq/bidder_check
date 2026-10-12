import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/database.types";
vi.mock("server-only", () => ({}));
import { getManagerFinancialValues } from "../src/lib/financial-data";
it("chunks combined financial identities under the server total limit and preserves zero/null", async () => {
  const sizes: number[] = [];
  const supabase = {
    rpc: async (
      _name: string,
      args: {
        p_bidder_ids: string[];
        p_resume_ids: string[];
        p_bid_ids: string[];
      },
    ) => {
      sizes.push(
        args.p_bidder_ids.length +
          args.p_resume_ids.length +
          args.p_bid_ids.length,
      );
      return {
        data: {
          bidders: Object.fromEntries(args.p_bidder_ids.map((id) => [id, 0])),
          resumes: Object.fromEntries(
            args.p_resume_ids.map((id) => [id, null]),
          ),
          bids: Object.fromEntries(args.p_bid_ids.map((id) => [id, 175])),
        },
        error: null,
      };
    },
  } as unknown as SupabaseClient<Database>;
  const values = await getManagerFinancialValues(supabase, {
    bidderIds: ["b", "b"],
    resumeIds: Array.from({ length: 1001 }, (_, i) => String(i)),
    bidIds: ["bid"],
  });
  expect(sizes).toEqual([1000, 3]);
  expect(values.bidders.b).toBe(0);
  expect(values.resumes["1000"]).toBeNull();
  expect(values.bids.bid).toBe(175);
});
it("propagates manager authorization failures without partial financial transport", async () => {
  const supabase = {
    rpc: async () => ({ data: null, error: { message: "Access denied" } }),
  } as unknown as SupabaseClient<Database>;
  await expect(
    getManagerFinancialValues(supabase, { bidIds: ["foreign"] }),
  ).rejects.toThrow("Access denied");
});
