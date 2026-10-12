import { describe, expect, it } from "vitest";
import type { BidRow } from "@/lib/workspace-types";

import { screenshotSizeSummary } from "@/lib/screenshot-size";
const summary = (fields: Record<string, unknown>, role = "client") =>
  screenshotSizeSummary({ evidence_file_id: "file", ...fields } as BidRow, role);

describe("screenshot size review labels", () => {
  it("shows the inclusive match count beside repeated sizes and size only for unique screenshots", () => {
    expect(summary({ screenshot_size_bytes: 102400, screenshot_size_match_count: 2 })?.badgeLabel).toBe("100 KB · 2");
    expect(summary({ screenshot_size_bytes: 102400, screenshot_size_match_count: 1 })?.badgeLabel).toBe("100 KB");
  });
  it("formats compact KB and MB labels while retaining exact bytes for comparison", () => {
    expect(summary({ screenshot_size_bytes: 102400, screenshot_size_match_count: 2 }))
      .toMatchObject({ label: "100 KB", bytes: 102400, count: 2, repeated: true });
    expect(summary({ screenshot_size_bytes: 102401, screenshot_size_match_count: 1 }))
      .toMatchObject({ label: "100 KB", bytes: 102401, count: 1, repeated: false });
    expect(summary({ screenshot_size_bytes: 1572864, screenshot_size_match_count: 1 }))
      .toMatchObject({ label: "1.5 MB", bytes: 1572864 });
  });

  it("never presents absent or malformed snapshot fields as zero or unique", () => {
    for (const fields of [
      {}, { screenshot_size_bytes: null, screenshot_size_match_count: 0 },
      { screenshot_size_bytes: 1024 },
      { screenshot_size_bytes: -1, screenshot_size_match_count: 1 },
      { screenshot_size_bytes: 1.5, screenshot_size_match_count: 1 },
      { screenshot_size_bytes: 1024, screenshot_size_match_count: 0 },
    ]) expect(summary(fields)).toMatchObject({ label: "Size unavailable", bytes: null });
  });

  it("hides metadata from bidders even if the transport accidentally includes it", () => {
    expect(summary({ screenshot_size_bytes: 102400, screenshot_size_match_count: 3 }, "bidder")).toBeNull();
  });

  it("shows badges to clients and admins only when a screenshot is attached", () => {
    const fields = { screenshot_size_bytes: 1024, screenshot_size_match_count: 1 };
    expect(summary(fields, "client")).toMatchObject({ label: "1 KB" });
    expect(summary(fields, "admin")).toMatchObject({ label: "1 KB" });
    expect(summary({ ...fields, evidence_file_id: null })).toBeNull();
  });

  it("colors exact-byte repeats consistently and keeps unique sizes neutral", () => {
    const match = summary({ screenshot_size_bytes: 102400, screenshot_size_match_count: 2 });
    const offPageMatch = summary({ screenshot_size_bytes: 102400, screenshot_size_match_count: 4 });
    expect(match?.colorClass).toBeTruthy();
    expect(offPageMatch?.colorClass).toBe(match?.colorClass);
    expect(summary({ screenshot_size_bytes: 102400, screenshot_size_match_count: 1 })?.colorClass).toBe("");
  });
});
