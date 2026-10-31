import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import { initialBidQuery } from "@/lib/read-keys";
const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  authError: null as unknown,
  contextReads: 0,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => {
  const context = async () => {
    state.contextReads++;
    if (state.authError) throw state.authError;
    return {
      profile: {
        id: "40000000-0000-4000-8000-000000000001",
        role: "bidder",
        approval_status: "approved",
        archived: false,
      },
      supabase: { rpc: state.rpc },
    };
  };
  return { getActor: context, getContext: context };
});
import { createReadServices } from "@/lib/read-services";
import { AuthorizationError } from "@/lib/authorization-error";
import {
  applicationLocationState,
  countryLabel,
} from "@/lib/application-location";
import type { ApplicationLocation } from "@/lib/upload-context-types";
const location: ApplicationLocation = {
  ip: "203.0.113.10",
  city: "Chicago",
  region: "IL",
  country: "US",
  uploadedAt: "2026-10-31T12:00:00Z",
  source: "vercel",
  status: "available",
};
beforeEach(() => {
  state.rpc.mockReset();
  state.authError = null;
  state.contextReads = 0;
});
afterEach(() => vi.unstubAllGlobals());
it("returns nullable application locations inline for bidders using one list RPC", async () => {
  const data = {
    rows: [
      { id: "one", applicationLocation: location },
      { id: "two", applicationLocation: null },
    ],
    total: 2,
    statusCounts: { all: 2 },
    sources: [],
    countryOptions: ["US"],
  };
  state.rpc.mockResolvedValue({ data, error: null });
  expect(
    await createReadServices().getBidRows(
      "all",
      "",
      "",
      false,
      undefined,
      initialBidQuery(),
    ),
  ).toEqual({ data });
  expect(state.contextReads).toBe(1);
  expect(state.rpc).toHaveBeenCalledTimes(1);
  expect(state.rpc).toHaveBeenCalledWith(
    "list_bids_v2",
    expect.objectContaining({
      p_query: expect.objectContaining({ ipCountry: "all" }),
    }),
  );
});
it.each(["all", "US", "non-US", "unknown", "CA"])(
  "passes %s country to SQL and defaults missing country to all",
  async (country) => {
    state.rpc.mockResolvedValue({
      data: { rows: [], total: 0, countryOptions: [] },
      error: null,
    });
    await createReadServices().getBidRows("all", "", "", false, undefined, {
      ...initialBidQuery(),
      ipCountry: country,
    });
    expect(state.rpc).toHaveBeenCalledWith(
      "list_bids_v2",
      expect.objectContaining({
        p_query: expect.objectContaining({ ipCountry: country }),
      }),
    );
  },
);
it("defaults omitted country and rejects malformed values before querying SQL", async () => {
  state.rpc.mockResolvedValue({
    data: { rows: [], total: 0, countryOptions: [] },
    error: null,
  });
  const query = initialBidQuery();
  delete query.ipCountry;
  await createReadServices().getBidRows("all", "", "", false, undefined, query);
  expect(state.rpc).toHaveBeenLastCalledWith(
    "list_bids_v2",
    expect.objectContaining({
      p_query: expect.objectContaining({ ipCountry: "all" }),
    }),
  );
  state.rpc.mockClear();
  expect(
    await createReadServices().getBidRows("all", "", "", false, undefined, {
      ...query,
      ipCountry: "USA",
    }),
  ).toHaveProperty("error");
  expect(state.rpc).not.toHaveBeenCalled();
});
it("retains navigation and live authorization failures", async () => {
  try {
    redirect("/auth/login");
  } catch (error) {
    state.authError = error;
  }
  await expect(
    createReadServices().getBidRows(
      "all",
      "",
      "",
      false,
      undefined,
      initialBidQuery(),
    ),
  ).rejects.toBe(state.authError);
  state.authError = new AuthorizationError("/auth/inactive");
  await expect(
    createReadServices().getBidRows(
      "all",
      "",
      "",
      false,
      undefined,
      initialBidQuery(),
    ),
  ).rejects.toBe(state.authError);
  expect(state.rpc).not.toHaveBeenCalled();
});
it("classifies applied US green, other/unknown amber, and unapplied neutral even with a saved location", () => {
  expect(applicationLocationState(true, location)).toBe("us");
  expect(applicationLocationState(true, { ...location, country: "CA" })).toBe(
    "warning",
  );
  expect(applicationLocationState(true, { ...location, country: null })).toBe(
    "warning",
  );
  expect(applicationLocationState(true, null)).toBe("warning");
  expect(applicationLocationState(false, location)).toBe("neutral");
  expect(countryLabel("US")).toBe("United States (US)");
  expect(countryLabel("CA")).toBe("Canada (CA)");
});
