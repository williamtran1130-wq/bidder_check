import { expect, it } from "vitest";
import { latestCollection } from "@/lib/collection-status";
const first = { status: "ready" as const, updatedAt: "2026-10-31T18:00:00Z", from: "2026-10-01", to: "2026-10-31" };
it("accepts a newer response when removal moves the last collection backwards", () => {
  const removed = { ...first, updatedAt: "2026-10-30T18:00:00Z", to: "2026-10-30" };
  expect(latestCollection({ value: removed, receivedAt: 20 }, { value: first, receivedAt: 10 })).toEqual(removed);
});
it("accepts coverage-only publication with an unchanged collection timestamp", () => {
  const changed = { ...first, from: "2026-10-15" };
  expect(latestCollection({ value: first, receivedAt: 10 }, { value: changed, receivedAt: 20 })).toEqual(changed);
});
