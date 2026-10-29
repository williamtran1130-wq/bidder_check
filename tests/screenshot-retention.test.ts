import { expect, it } from "vitest";
import { fileUrlLifetime, screenshotStatus } from "@/lib/screenshot-retention";

const now = Date.parse("2026-10-29T12:00:00Z");
it("caps signed screenshot access at the remaining retention window", () => {
  expect(
    fileUrlLifetime(
      { kind: "screenshot", finalized_at: "2026-10-22T12:00:30Z" },
      now,
    ),
  ).toBe(30);
  expect(
    fileUrlLifetime(
      { kind: "screenshot", finalized_at: "2026-10-22T12:00:00Z" },
      now,
    ),
  ).toBe(0);
  expect(
    fileUrlLifetime(
      { kind: "screenshot", finalized_at: "2026-10-22T11:59:59Z" },
      now,
    ),
  ).toBe(0);
  expect(
    fileUrlLifetime(
      { kind: "screenshot", finalized_at: "2026-10-28T12:00:00Z" },
      now,
    ),
  ).toBe(60);
  expect(
    fileUrlLifetime(
      { kind: "resume", finalized_at: "2026-09-01T00:00:00Z" },
      now,
    ),
  ).toBe(60);
});
it("distinguishes uploaded, expired, and never-uploaded proof independently of application state", () => {
  expect(
    screenshotStatus(
      {
        evidence_file_id: "proof",
        screenshot_uploaded_at: "2026-10-28T12:00:00Z",
      },
      now,
    ),
  ).toBe("uploaded");
  expect(
    screenshotStatus(
      {
        evidence_file_id: null,
        screenshot_uploaded_at: "2026-10-22T12:00:00Z",
      },
      now,
    ),
  ).toBe("expired");
  expect(
    screenshotStatus(
      {
        evidence_file_id: "proof",
        screenshot_uploaded_at: "2026-10-22T12:00:00Z",
      },
      now,
    ),
  ).toBe("expired");
  expect(screenshotStatus({ evidence_file_id: null }, now)).toBe(
    "not_uploaded",
  );
});
