import { existsSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
const state = vi.hoisted(() => ({
  profile: { id: "40000000-0000-4000-8000-000000000001", role: "client", approval_status: "approved", archived: false },
  rpc: vi.fn(), verified: vi.fn(), file: { id: "40000000-0000-4000-8000-000000000002", created_by: "40000000-0000-4000-8000-000000000001", kind: "screenshot", mime: "image/png", size_bytes: 0, storage_path: "fixture/proof" },
  bytes: new Uint8Array(), headers: new Headers(), headerReads: 0, download: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => { state.headerReads++; return state.headers; } }));
vi.mock("@/lib/auth", () => ({ getContext: async () => ({ profile: state.profile, supabase: {
  rpc: state.rpc,
  from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: state.file }) }) }) }),
  storage: { from: () => ({ download: state.download }) },
} }) }));
vi.mock("@/lib/admin", () => ({ adminClient: () => ({ rpc: state.verified }) }));
vi.mock("@/lib/storage-cleanup", () => ({ runStorageCleanup: vi.fn() }));
import { finalizeUpload } from "@/app/(workspace)/actions";
const actions = existsSync("src/app/(workspace)/upload-context-actions.ts")
  ? await import("@/app/(workspace)/upload-context-actions")
  : { getScreenshotUploadContext: async () => ({ error: "Unavailable" }), getScreenshotUploadHistory: async () => ({ error: "Unavailable" }) };
const fileId = "40000000-0000-4000-8000-000000000002", bidId = "40000000-0000-4000-8000-000000000003";
beforeEach(async () => {
  vi.stubEnv("VERCEL", "1");
  state.profile = { id: "40000000-0000-4000-8000-000000000001", role: "client", approval_status: "approved", archived: false };
  state.file.created_by = state.profile.id;
  state.file.kind = "screenshot"; state.file.mime = "image/png"; state.headerReads = 0;
  state.bytes = new Uint8Array(await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } }).png().toBuffer());
  state.file.size_bytes = state.bytes.length;
  state.headers = new Headers({ "x-vercel-forwarded-for": "203.0.113.10", "x-vercel-ip-city": "Chicago", "x-vercel-ip-country-region": "IL", "x-vercel-ip-country": "US" });
  state.rpc.mockReset(); state.verified.mockReset(); state.download.mockReset();
  state.download.mockImplementation(async () => ({ data: new Blob([state.bytes]) }));
});
it("captures request metadata at authenticated finalization through the versioned atomic service boundary", async () => {
  state.verified.mockImplementation(async (name, args) => name === "finalize_verified_file_v2" && args.p_actor === state.profile.id && args.p_context.ip === "203.0.113.10" && args.p_context.city === "Chicago"
    ? { data: null, error: null } : { error: { message: "Missing verified upload context" } });
  expect(await finalizeUpload(fileId)).toEqual({ data: fileId });
});
it("rejects another uploader and malformed evidence without finalizing or collecting context", async () => {
  state.file.created_by = bidId;
  expect(await finalizeUpload(fileId)).toMatchObject({ error: expect.stringMatching(/uploader/i) });
  expect(state.verified).not.toHaveBeenCalled();
  state.file.created_by = state.profile.id;
  state.download.mockResolvedValue({ data: new Blob(["invalid-image"]) });
  expect(await finalizeUpload(fileId)).toHaveProperty("error"); expect(state.verified).not.toHaveBeenCalled();
});
it("does not collect screenshot request metadata for resume uploads", async () => {
  state.file.kind = "resume"; state.file.mime = "application/pdf";
  const pdf = new Blob(["%PDF-fixture"]); state.file.size_bytes = pdf.size; state.download.mockResolvedValue({ data: pdf });
  state.verified.mockResolvedValue({ error: null });
  expect(await finalizeUpload(fileId)).toEqual({ data: fileId });
  expect(state.headerReads).toBe(0);
});
it("returns manager lookup and bounded history responses through the caller JWT", async () => {
  state.rpc.mockImplementation(async (name, args) => {
    if (name === "manager_screenshot_upload_context" && args.p_file === fileId) return { data: null };
    if (name === "manager_screenshot_upload_history" && args.p_bid === bidId && args.p_before_id === fileId && args.p_before_at === "2026-10-12T12:00:00Z") return { data: { items: [], nextCursor: null } };
    return { error: { message: "Wrong review boundary" } };
  });
  expect(await actions.getScreenshotUploadContext(fileId)).toEqual({ data: null });
  expect(await actions.getScreenshotUploadHistory(bidId, { uploadedAt: "2026-10-12T12:00:00Z", id: fileId })).toEqual({ data: { items: [], nextCursor: null } });
});
it("rejects bidder, archived and unapproved manager reads and incomplete cursor input before database access", async () => {
  for (const patch of [{ role: "bidder" }, { archived: true }, { approval_status: "pending" }]) {
    const saved = { ...state.profile }; Object.assign(state.profile, patch);
    expect(await actions.getScreenshotUploadContext(fileId)).toHaveProperty("error");
    expect(await actions.getScreenshotUploadHistory(bidId)).toHaveProperty("error");
    state.profile = saved;
  }
  expect(await actions.getScreenshotUploadHistory(bidId, { uploadedAt: "bad-date", id: fileId })).toHaveProperty("error");
  expect(state.rpc).not.toHaveBeenCalled();
});
it("keeps private SQL detail out of manager load failures", async () => {
  state.rpc.mockResolvedValue({ error: { message: "private-network-detail", code: "57014" } });
  const result = await actions.getScreenshotUploadHistory(bidId);
  expect(result).toHaveProperty("error"); expect(JSON.stringify(result)).not.toContain("private-network-detail");
});
