import { formatInTimeZone } from "date-fns-tz";
import { CALENDAR_TIMEZONE, isCalendarPeriod, periodTimestampBounds, resolveCalendarPeriod } from "./calendar-period";
export const BID_TIMEZONE = CALENDAR_TIMEZONE;
export function formatCTDateBucket(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("Enter a valid calendar date.");
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== value)
    throw new Error("Enter a valid calendar date.");
  return formatInTimeZone(instant, "UTC", "MMM d");
}
export function chicagoDateRange(
  mode: string,
  from: string,
  to: string,
  now = new Date(),
): { from?: string; to?: string } {
  if (!isCalendarPeriod(mode)) throw new Error("Invalid date filter");
  return periodTimestampBounds(resolveCalendarPeriod({ preset: mode, from, to }, now));
}

export function normalizeJobUrl(input: string) {
  const url = new URL(input.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Enter a valid HTTP or HTTPS job URL.");
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (
      /^utm_/i.test(key) ||
      ["fbclid", "gclid", "msclkid"].includes(key.toLowerCase())
    )
      url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}
export function localDateTimeToISO(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Enter a valid date and time.");
  return date.toISOString();
}
export function parseTimestamp(value: string) {
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value))
    throw new Error("Timestamp must include a timezone.");
  return localDateTimeToISO(value);
}
export function moneyToCents(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    throw new Error("Use a positive USD amount with up to two decimals.");
  const [whole, decimal = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 100000000)
    throw new Error("Rate is too large.");
  return cents;
}
export function effectiveRate(bidder: number | null, resume: number | null) {
  return resume ?? bidder;
}
export function summarizeEarnings(
  rows: {
    id: string;
    applied: boolean;
    evidence_file_id: string | null;
    rate_cents: number | null;
    deleted_at?: string | null;
  }[],
) {
  const eligible = [...new Map(rows.map((r) => [r.id, r])).values()].filter(
    (r) =>
      !r.deleted_at && r.applied && r.evidence_file_id && r.rate_cents !== null,
  );
  return {
    count: eligible.length,
    cents: eligible.reduce((sum, r) => sum + (r.rate_cents ?? 0), 0),
  };
}
export function dateInRange(
  timestamp: string,
  from: string,
  to: string,
  timezone: string,
) {
  const date = formatInTimeZone(timestamp, timezone, "yyyy-MM-dd");
  return (!from || date >= from) && (!to || date <= to);
}
export const uploadTypes = {
  screenshot: ["image/png", "image/jpeg", "image/webp"],
  resume: ["application/pdf"],
};
export function validateUpload(
  kind: keyof typeof uploadTypes,
  mime: string,
  size: number,
) {
  if (!uploadTypes[kind].includes(mime))
    throw new Error("This file type is not supported.");
  if (size <= 0 || size > 10 * 1024 * 1024)
    throw new Error("Choose a file between 1 byte and 10 MB.");
}
export function usd(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}
export function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
}
