import type { ApplicationLocation } from "./upload-context-types";

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
export function countryLabel(country: string) {
  return `${countryNames.of(country) ?? country} (${country})`;
}
export function applicationLocationState(
  applied: boolean,
  location?: ApplicationLocation | null,
) {
  if (!applied) return "neutral";
  return location?.country === "US" ? "us" : "warning";
}
