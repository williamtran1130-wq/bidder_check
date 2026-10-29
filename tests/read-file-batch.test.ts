import { expect, it, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
const h = vi.hoisted(() => ({
  from: vi.fn(),
  sign: vi.fn(),
  adminSign: vi.fn(),
  files: [] as unknown[],
}));
vi.mock("@/lib/admin", () => ({
  adminClient: () => ({
    storage: { from: () => ({ createSignedUrl: h.adminSign }) },
  }),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  getContext: async () => ({
    profile: { role: "bidder" },
    supabase: {
      from: h.from,
      storage: { from: () => ({ createSignedUrl: h.sign }) },
    },
  }),
}));
beforeEach(() => {
  h.adminSign
    .mockReset()
    .mockResolvedValue({ data: { signedUrl: "server-signed" }, error: null });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
  h.sign
    .mockReset()
    .mockResolvedValue({ data: { signedUrl: "signed" }, error: null });
  h.from.mockImplementation(() => {
    const q = {
      select: () => q,
      in: () => q,
      eq: async () => ({ data: h.files, error: null }),
    };
    return q;
  });
});
it("server-signs only authorized unexpired screenshot paths and caps their remaining lifetime", async () => {
  const { getFileUrls } = await import("@/lib/read-services");
  const first = "00000000-0000-4000-8000-000000000001",
    expired = "00000000-0000-4000-8000-000000000002";
  h.files = [
    {
      id: first,
      kind: "screenshot",
      finalized_at: "2026-10-06T12:00:30Z",
      storage_path: "allowed/proof",
      filename: "proof.png",
      mime: "image/png",
    },
    {
      id: expired,
      kind: "screenshot",
      finalized_at: "2026-10-06T12:00:00Z",
      storage_path: "expired/proof",
      filename: "old.png",
      mime: "image/png",
    },
  ];
  const result = await getFileUrls([first, expired]);
  expect(result.data?.[0]).toMatchObject({
    data: { url: "server-signed", expiresAt: "2026-10-13T12:00:30.000Z" },
  });
  expect(result.data?.[1]).toMatchObject({ error: "Screenshot has expired." });
  expect(h.adminSign).toHaveBeenCalledExactlyOnceWith("allowed/proof", 30);
  expect(h.sign).not.toHaveBeenCalled();
  vi.useRealTimers();
});
it("batch returns individual invalid/missing outcomes and signs only RLS-visible file paths for sixty seconds", async () => {
  expect(existsSync("src/lib/read-services.ts")).toBe(true);
  const { getFileUrls } = await import("@/lib/read-services");
  const id = "00000000-0000-4000-8000-000000000001",
    denied = "00000000-0000-4000-8000-000000000002";
  h.files = [
    {
      id,
      storage_path: "authorized/history.png",
      filename: "history.png",
      mime: "image/png",
    },
  ];
  const result = await getFileUrls([id, denied, "bad"]);
  expect(h.sign).toHaveBeenCalledExactlyOnceWith("authorized/history.png", 60);
  expect(result.data).toEqual([
    {
      id,
      data: {
        url: "signed",
        name: "history.png",
        mime: "image/png",
        expiresAt: "2026-10-13T12:01:00.000Z",
      },
    },
    { id: denied, error: "File is unavailable." },
    { id: "bad", error: "Invalid file ID." },
  ]);
  vi.useRealTimers();
});
it("rejects batches over one hundred before file lookups", async () => {
  expect(existsSync("src/lib/read-services.ts")).toBe(true);
  h.from.mockClear();
  const { getFileUrls } = await import("@/lib/read-services");
  expect(await getFileUrls(Array(101).fill("x"))).toMatchObject({
    error: expect.any(String),
  });
  expect(h.from).not.toHaveBeenCalled();
  vi.useRealTimers();
});
it("keeps independent batch outcomes when one storage request throws", async () => {
  const { getFileUrls } = await import("@/lib/read-services");
  const first = "00000000-0000-4000-8000-000000000001",
    second = "00000000-0000-4000-8000-000000000002";
  h.files = [
    { id: first, storage_path: "first", filename: "first", mime: "image/png" },
    {
      id: second,
      storage_path: "second",
      filename: "second",
      mime: "image/png",
    },
  ];
  h.sign.mockRejectedValueOnce(new Error("network failure"));
  const result = await getFileUrls([first, second]);
  expect(result.data).toEqual([
    { id: first, error: "File is unavailable." },
    { id: second, data: expect.objectContaining({ url: "signed" }) },
  ]);
  vi.useRealTimers();
});
