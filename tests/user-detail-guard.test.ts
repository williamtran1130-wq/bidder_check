import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/data", () => ({ getWorkspaceData: state.load }));
vi.mock("@/components/bidder-detail", () => ({ BidderDetail: () => null }));
import Page from "@/app/(workspace)/users/[id]/page";
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => { state.load.mockReset(); state.load.mockResolvedValue({ profile: { role: "client" }, bidders: [{ user_id: id }] }); });
it("returns not-found for a malformed route ID without a workspace query", async () => {
  await expect(Page({ params: Promise.resolve({ id: "not-a-uuid" }) })).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  expect(state.load).not.toHaveBeenCalled();
});
it("keeps authorized valid IDs and unavailable or bidder access semantics", async () => {
  expect((await Page({ params: Promise.resolve({ id }) })).props.id).toBe(id);
  state.load.mockResolvedValue({ profile: { role: "bidder" }, bidders: [{ user_id: id }] });
  await expect(Page({ params: Promise.resolve({ id }) })).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  state.load.mockResolvedValue({ profile: { role: "client" }, bidders: [] });
  await expect(Page({ params: Promise.resolve({ id }) })).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
});
