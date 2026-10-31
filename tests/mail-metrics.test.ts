import { expect, it } from "vitest";
import { sample } from "./mail-insights-report.test";
import { projectMailMetrics, confirmationBuckets, invitationRate } from "@/lib/mail-metrics";

it("deduplicates assigned mailboxes and marks incomplete groups without changing the available counts", () => {
  const metrics = projectMailMetrics(sample, "bidder");
  expect(metrics.total).toMatchObject({ confirmations: 3, invitations: 2, status: "partial" });
  expect(metrics.groups.get("b1")?.metric.status).toBe("partial");
  expect(metrics.groups.get("b2")?.metric).toMatchObject({ confirmations: 3, invitations: 2, status: "ready", shared: true });
  expect(invitationRate(metrics.groups.get("b2")!.metric, 1)).toBe(200);
  expect(invitationRate(metrics.total, 1)).toBeNull();
  expect(invitationRate(metrics.groups.get("b2")!.metric, 0)).toBeNull();
});
it("uses stable assignment IDs and distinguishes covered zero from unsynced and unknown coverage", () => {
  const metrics = projectMailMetrics(sample, "assignment");
  expect(metrics.groups.get("a1")?.metric.confirmations).toBe(3);
  expect(metrics.groups.get("a3")?.metric).toMatchObject({ confirmations: null, status: "not_synced" });
  const covered = { ...sample, assignments: sample.assignments.slice(0, 1), mailboxes: sample.mailboxes.slice(0, 1).map(m => ({ ...m, rows: [] })) };
  expect(projectMailMetrics(covered, "profile").total).toMatchObject({ confirmations: 0, status: "ready" });
  expect(projectMailMetrics({ ...covered, mailboxes: covered.mailboxes.map(m => ({ ...m, coverage_start: null })) }, "profile").total.status).toBe("partial");
  expect(projectMailMetrics({ ...sample, range: { ...sample.range, empty: true } }, "profile").total).toMatchObject({ confirmations: null, status: "outside_retention" });
  expect(projectMailMetrics(undefined, "profile").total.confirmations).toBeNull();
});
it("uses inclusive calendar bucket boundaries, preserves retention gaps and marks overlapping buckets partial", () => {
  const report = { ...sample, assignments: sample.assignments.slice(0, 2) };
  const values = confirmationBuckets(report, [{ from: "2026-10-01", to: "2026-10-28" }, { from: "2026-10-28", to: "2026-10-29" }, { from: "2026-10-30", to: "2026-10-30" }]);
  expect(values.map(v => [v.confirmations, v.status])).toEqual([[null, "outside_retention"], [3, "partial"], [0, "ready"]]);
});

it("suppresses rates after collection stops, including mixed fresh and stale mailboxes", () => {
  const report = { ...sample, assignments: sample.assignments.slice(0, 1), mailboxes: sample.mailboxes.slice(0, 1).map(m => ({ ...m, collected_at: "2026-10-29T18:00:00Z" })) };
  const metrics = projectMailMetrics(report, "profile");
  expect(metrics.total).toMatchObject({ confirmations: 3, invitations: 2, status: "partial" });
  expect(metrics.daily[1].metric.status).toBe("partial");
  expect(invitationRate(metrics.total, 1)).toBeNull();
  const mixed = { ...report, assignments: sample.assignments, mailboxes: [...report.mailboxes, { ...report.mailboxes[0], email: "missing@example.test", collected_at: "2026-10-30T18:00:00Z", rows: [] }] };
  expect(projectMailMetrics(mixed, "bidder").total.status).toBe("partial");
});

it.each([
  ["2026-11-01", "2026-11-01T04:59:59Z", "partial"],
  ["2026-11-01", "2026-11-01T05:00:00Z", "ready"],
  ["2026-11-02", "2026-11-02T05:59:59Z", "partial"],
  ["2026-11-02", "2026-11-02T06:00:00Z", "ready"],
  ["2026-11-02", "invalid", "partial"],
])("uses CT collection day across DST: %s / %s is %s", (date, collected, expected) => {
  const report = { ...sample, range: { from: date, to: date, clipped: false }, assignments: sample.assignments.slice(0, 1), mailboxes: sample.mailboxes.slice(0, 1).map(m => ({ ...m, collected_at: collected, rows: [] })) };
  expect(projectMailMetrics(report, "profile").total.status).toBe(expected);
});
