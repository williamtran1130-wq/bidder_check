import type { BidRow } from "./workspace-types";

// Fixed foreground/background pairs remain legible in both themes. Colors are
// an aid only: exact bytes in the label distinguish any palette collisions.
const repeatColors = [
  "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200",
  "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200",
  "border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-200",
  "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200",
  "border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200",
];

export function screenshotSizeSummary(bid: BidRow, role: string) {
  if ((role !== "client" && role !== "admin") || !bid.evidence_file_id) return null;
  const bytes = bid.screenshot_size_bytes;
  const count = bid.screenshot_size_match_count;
  if (!Number.isSafeInteger(bytes) || bytes == null || bytes <= 0 ||
      !Number.isSafeInteger(count) || count == null || count < 1) {
    return { label: "Size unavailable", bytes: null, count: 0, repeated: false, colorClass: "" };
  }
  const unit = bytes >= 1024 * 1024 ? "MB" : "KB";
  const amount = bytes / (unit === "MB" ? 1024 * 1024 : 1024);
  const repeated = count >= 2;
  const label = `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(amount)} ${unit}`;
  return {
    label,
    badgeLabel: repeated ? `${label} · ${count}` : label,
    bytes, count, repeated,
    colorClass: repeated ? repeatColors[bytes % repeatColors.length] : "",
  };
}
