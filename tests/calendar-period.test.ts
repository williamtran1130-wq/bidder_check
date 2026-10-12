import { describe, expect, it } from "vitest";
import { resolveCalendarPeriod, periodTimestampBounds } from "@/lib/calendar-period";

describe("CT calendar periods", () => {
  const now = new Date("2026-10-14T16:00:00Z");
  it.each([
    ["today", "2026-10-14", "2026-10-14"],
    ["yesterday", "2026-10-13", "2026-10-13"],
    ["this_week", "2026-10-12", "2026-10-14"],
    ["last_week", "2026-10-05", "2026-10-11"],
    ["this_month", "2026-10-01", "2026-10-14"],
    ["last_month", "2026-09-01", "2026-09-30"],
  ] as const)("resolves %s using complete prior periods", (preset, from, to) => {
    expect(resolveCalendarPeriod({ preset }, now)).toEqual({ from, to });
  });
  it("keeps Sunday in the current Monday-start week across UTC midnight", () => {
    expect(resolveCalendarPeriod({ preset: "this_week" }, new Date("2026-10-12T04:59:00Z")))
      .toEqual({ from: "2026-10-05", to: "2026-10-11" });
  });
  it("crosses year and leap-month boundaries", () => {
    expect(resolveCalendarPeriod({ preset: "last_month" }, new Date("2027-01-01T12:00Z")))
      .toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(resolveCalendarPeriod({ preset: "last_month" }, new Date("2024-03-01T12:00Z")))
      .toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(resolveCalendarPeriod({ preset: "this_week" }, new Date("2027-01-01T12:00Z")))
      .toEqual({ from: "2026-12-28", to: "2027-01-01" });
  });
  it("leaves all-time bounds unbounded", () => {
    expect(resolveCalendarPeriod({ preset: "all" }, now)).toEqual({});
    expect(periodTimestampBounds({})).toEqual({});
  });
  it("produces exclusive CT day bounds across both DST changes", () => {
    expect(periodTimestampBounds({ from: "2026-03-08", to: "2026-03-08" }))
      .toEqual({ from: "2026-03-08T06:00:00.000Z", to: "2026-03-09T05:00:00.000Z" });
    expect(periodTimestampBounds({ from: "2026-11-01", to: "2026-11-01" }))
      .toEqual({ from: "2026-11-01T05:00:00.000Z", to: "2026-11-02T06:00:00.000Z" });
  });
  it.each([["", "2026-10-14"], ["2026-02-30", "2026-03-01"], ["2026-10-15", "2026-10-14"]])(
    "rejects incomplete, impossible and reversed ranges", (from, to) => {
      expect(() => resolveCalendarPeriod({ preset: "custom", from, to }, now)).toThrow();
    },
  );
});
