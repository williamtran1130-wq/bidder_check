export const SCREENSHOT_RETENTION_MS = 168 * 60 * 60 * 1000;

export function screenshotStatus(
  bid: {
    evidence_file_id: string | null;
    screenshot_uploaded_at?: string | null;
  },
  now = Date.now(),
): "not_uploaded" | "uploaded" | "expired" {
  const uploaded = Date.parse(bid.screenshot_uploaded_at ?? "");
  if (Number.isFinite(uploaded) && now >= uploaded + SCREENSHOT_RETENTION_MS)
    return "expired";
  if (bid.evidence_file_id) return "uploaded";
  return Number.isFinite(uploaded) ? "expired" : "not_uploaded";
}

export function fileUrlLifetime(
  file: { kind?: string; finalized_at?: string | null },
  now = Date.now(),
) {
  if (file.kind !== "screenshot") return 60;
  const expiry = Date.parse(file.finalized_at ?? "") + SCREENSHOT_RETENTION_MS;
  return Number.isFinite(expiry)
    ? Math.max(0, Math.min(60, Math.floor((expiry - now) / 1000)))
    : 0;
}
