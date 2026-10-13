import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import type { UploadContext } from "@/lib/upload-context-types";

const state = vi.hoisted(() => ({
  profile: { id: "40000000-0000-4000-8000-000000000001", role: "client", approval_status: "approved", archived: false },
  rpc: vi.fn(),
  contextReads: 0,
  authError: null as unknown,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => {
  const context = async () => {
    state.contextReads++;
    if (state.authError) throw state.authError;
    return { profile: state.profile, supabase: { rpc: state.rpc } };
  };
  return { getActor: context, getContext: context };
});

import { AuthorizationError } from "@/lib/authorization-error";
import { createReadServices } from "@/lib/read-services";
import { handleRead } from "@/lib/read-handler";
import { getScreenshotUploadContexts } from "@/lib/read-client";

const fileId = "40000000-0000-4000-8000-000000000002";
const absentId = "40000000-0000-4000-8000-000000000003";
const deniedId = "40000000-0000-4000-8000-000000000004";
const thrownId = "40000000-0000-4000-8000-000000000005";
const context: UploadContext = {
  id: "40000000-0000-4000-8000-000000000006",
  bidId: "40000000-0000-4000-8000-000000000007",
  originalFileId: fileId,
  bidderId: "40000000-0000-4000-8000-000000000008",
  uploaderId: "40000000-0000-4000-8000-000000000008",
  uploaderRole: "bidder",
  uploaderName: "Fixture bidder",
  uploadedAt: "2026-10-13T12:00:00Z",
  ip: "203.0.113.10",
  city: "Chicago",
  region: "IL",
  country: "US",
  source: "vercel",
  status: "available",
  fileAvailable: true,
  filename: "fixture.png",
};

beforeEach(() => {
  state.profile = { id: "40000000-0000-4000-8000-000000000001", role: "client", approval_status: "approved", archived: false };
  state.authError = null;
  state.contextReads = 0;
  state.rpc.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

it("returns inline upload context with one live actor lookup, deduplicated IDs and private responses", async () => {
  state.rpc.mockImplementation(async (name, args) => name === "manager_screenshot_upload_context" && args.p_file === fileId
    ? { data: context, error: null }
    : { error: { message: "Wrong authorization boundary" } });
  const response = await handleRead(new Request("https://local/api/read/upload-contexts", {
    method: "POST", body: JSON.stringify([fileId, fileId]),
  }), "upload-contexts");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Vary")).toBe("Cookie");
  expect(await response.json()).toEqual({ data: [{ id: fileId, data: context }] });
  expect(state.contextReads).toBe(1);
  expect(state.rpc).toHaveBeenCalledTimes(1);
});

it("keeps null historical metadata distinct from per-file failures without disclosing SQL details", async () => {
  state.rpc.mockImplementation(async (name, args) => {
    if (name !== "manager_screenshot_upload_context") throw new Error("Wrong RPC");
    if (args.p_file === fileId) return { data: context, error: null };
    if (args.p_file === absentId) return { data: null, error: null };
    if (args.p_file === thrownId) throw new Error("private thrown database detail");
    return { data: null, error: { message: "private SQL policy detail", code: "42501" } };
  });
  const result = await createReadServices().getScreenshotUploadContexts([fileId, absentId, deniedId, thrownId]);
  expect(result.data?.map((item) => ({ id: item.id, data: item.data }))).toEqual([
    { id: fileId, data: context }, { id: absentId, data: null }, { id: deniedId, data: undefined }, { id: thrownId, data: undefined },
  ]);
  expect(result.data?.[2].error).toMatch(/could not be loaded/i);
  expect(result.data?.[3].error).toMatch(/could not be loaded/i);
  expect(JSON.stringify(result)).not.toMatch(/private|42501/);
});

it.each([
  { role: "bidder", approval_status: "approved", archived: false },
  { role: "client", approval_status: "approved", archived: true },
  { role: "client", approval_status: "pending", archived: false },
  { role: "client", approval_status: "rejected", archived: false },
  { role: "admin", approval_status: "pending", archived: false },
])("denies $role/$approval_status/archived=$archived before loading any private context", async (patch) => {
  Object.assign(state.profile, patch);
  expect(await createReadServices().getScreenshotUploadContexts([fileId])).toEqual({ error: "Access denied" });
  expect(state.rpc).not.toHaveBeenCalled();
});

it.each(["client", "admin"])("allows approved active %s batch reads", async (role) => {
  state.profile.role = role;
  state.rpc.mockResolvedValue({ data: context, error: null });
  expect(await createReadServices().getScreenshotUploadContexts([fileId])).toEqual({ data: [{ id: fileId, data: context }] });
});

it("rejects malformed UUIDs and oversized batches before any metadata query", async () => {
  const reads = createReadServices();
  expect(await reads.getScreenshotUploadContexts([fileId, "bad-id"])).toHaveProperty("error");
  expect(await reads.getScreenshotUploadContexts(Array(101).fill(fileId))).toHaveProperty("error");
  expect(state.rpc).not.toHaveBeenCalled();
  expect(await reads.getScreenshotUploadContexts([])).toEqual({ data: [] });
  expect(state.rpc).not.toHaveBeenCalled();
});

it("bounds a 100-file read to four concurrent authorized RPCs and preserves requested order", async () => {
  const ids = Array.from({ length: 100 }, (_, index) => `40000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`);
  let active = 0, peak = 0;
  const gates: Array<() => void> = [];
  state.rpc.mockImplementation(async (_name, args) => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => gates.push(resolve));
    active--;
    return { data: { ...context, originalFileId: args.p_file }, error: null };
  });
  const pending = createReadServices().getScreenshotUploadContexts(ids);
  for (let index = 0; index < 25; index++) {
    await vi.waitFor(() => expect(gates.length).toBe(4));
    expect(active).toBe(4);
    gates.splice(0).forEach((resolve) => resolve());
  }
  const result = await pending;
  expect(peak).toBe(4);
  expect(active).toBe(0);
  expect(result.data?.map((item) => item.id)).toEqual(ids);
  expect(result.data?.every((item) => item.data?.originalFileId === item.id)).toBe(true);
});

it("retains framework navigation and live authorization failures instead of treating them as missing metadata", async () => {
  try { redirect("/auth/login"); } catch (error) { state.authError = error; }
  await expect(createReadServices().getScreenshotUploadContexts([fileId])).rejects.toBe(state.authError);
  state.authError = new AuthorizationError("/auth/inactive");
  await expect(createReadServices().getScreenshotUploadContexts([fileId])).rejects.toBe(state.authError);
  const response = await handleRead(new Request("https://local/api/read/upload-contexts", { method: "POST", body: JSON.stringify([fileId]) }), "upload-contexts");
  expect(response.status).toBe(403);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ destination: "/auth/inactive" });
  expect(state.rpc).not.toHaveBeenCalled();
});

it("posts bounded metadata IDs without putting them in the URL or making a serialized Server Action", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: fileId, data: null }] })));
  vi.stubGlobal("fetch", fetcher);
  expect(await getScreenshotUploadContexts([fileId])).toEqual({ data: [{ id: fileId, data: null }] });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith("/api/read/upload-contexts", {
    method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify([fileId]),
  });
});
