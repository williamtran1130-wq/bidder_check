import type { UploadContext, UploadContextCursor, UploadHistoryPage } from "@/lib/upload-context-types";

// Component-only fixture data: TEST-NET addresses, never production records.
document.documentElement.setAttribute("data-upload-context-reads", "0");
document.documentElement.setAttribute("data-upload-history-reads", "0");
function increment(attribute: string) {
  const n = Number(document.documentElement.getAttribute(attribute) ?? 0) + 1;
  document.documentElement.setAttribute(attribute, String(n)); return n;
}
function record(fileId: string, bidId = "bid-0"): UploadContext {
  return { id: "50000000-0000-4000-8000-000000000001", bidId, originalFileId: fileId, bidderId: "bidder-0", uploaderId: "bidder-0", uploaderRole: "bidder", uploaderName: "Jordan Upload", uploadedAt: "2026-10-12T16:30:00Z", ip: "203.0.113.10", city: "Chicago", region: "IL", country: "US", source: "vercel", status: "available", fileAvailable: true, filename: "proof.png" };
}
export async function getScreenshotUploadContext(fileId: string): Promise<{ data?: UploadContext | null; error?: string }> {
  const n = increment("data-upload-context-reads"), params = new URLSearchParams(location.search);
  if (params.get("role") === "bidder") return { error: "Access denied" };
  if (params.has("upload-context-error") || (params.has("upload-context-recover") && n === 1)) return { error: "Upload details could not be loaded. Please retry." };
  if (params.has("upload-context-old")) return { data: null };
  const data = record(fileId);
  return { data: params.has("upload-context-unavailable") ? { ...data, ip: null, city: null, region: null, country: null, source: "unavailable", status: "unavailable" } : data };
}
export async function getScreenshotUploadHistory(bidId: string, cursor?: UploadContextCursor | null): Promise<{ data?: UploadHistoryPage; error?: string }> {
  increment("data-upload-history-reads"); const params = new URLSearchParams(location.search);
  if (params.get("role") === "bidder") return { error: "Access denied" };
  if (params.has("upload-context-error")) return { error: "Upload history could not be loaded. Please retry." };
  const first = record("file-0", bidId);
  const deleted: UploadContext = { ...first, id: "50000000-0000-4000-8000-000000000002", originalFileId: "removed-file", uploaderId: "client-0", uploaderName: "Casey Manager", uploaderRole: "client", uploadedAt: "2026-10-11T16:30:00Z", fileAvailable: false, filename: null, ip: "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", city: "São Paulo", region: "SP", country: "BR" };
  if (cursor) return { data: { items: [{ ...first, id: "50000000-0000-4000-8000-000000000003", uploadedAt: "2026-10-10T16:30:00Z" }], nextCursor: null } };
  return { data: { items: [first, deleted], nextCursor: params.has("upload-context-pages") ? { uploadedAt: deleted.uploadedAt, id: deleted.id } : null } };
}
