import { describe, expect, it } from "vitest";
import { applicationRate, dashboardDateLabel } from "@/lib/dashboard-report";

describe("dashboard reporting dates and cohorts", () => {
  it("uses found-date applied applications as the rate denominator", () => {
    expect(applicationRate(10, 4)).toBe(40);
    expect(applicationRate(0, 0)).toBeNull();
  });

  it("labels a CT date bucket without converting UTC midnight into the prior day", () => {
    expect(dashboardDateLabel("2026-10-05")).toBe("Oct 5, 2026");
  });

  it("rejects impossible bucket dates", () => {
    expect(() => dashboardDateLabel("2026-02-31")).toThrow();
  });
});
