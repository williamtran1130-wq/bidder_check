import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
let preview: typeof import("./preview/notification-actions").previewNotificationSchedule;
beforeAll(async () => {
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { location: { search: "" } }),
  );
  preview = (await import("./preview/notification-actions"))
    .previewNotificationSchedule;
});
afterEach(() => vi.useRealTimers());
afterAll(() => vi.unstubAllGlobals());
it("previews daily 09:00 at the next Central morning and selected weekdays at their authored time", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T02:45:00Z"));
  expect(
    (await preview({ kind: "daily", local_time: "09:00" })).data?.next_at,
  ).toBe("2026-10-13T14:00:00.000Z");
  expect(
    (await preview({ kind: "weekly", local_time: "09:00", weekdays: [4] })).data
      ?.next_at,
  ).toBe("2026-10-15T14:00:00.000Z");
});
it("matches spring-forward shift and first fall-back occurrence in the preview fixture", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-08T06:00:00Z"));
  expect(
    (await preview({ kind: "daily", local_time: "02:30" })).data?.next_at,
  ).toBe("2026-03-08T08:30:00.000Z");
  expect(
    (await preview({ kind: "once", scheduled_local: "2026-03-08T02:30" }))
      .error,
  ).toMatch(/does not exist/);
  vi.setSystemTime(new Date("2026-11-01T05:00:00Z"));
  expect(
    (await preview({ kind: "daily", local_time: "01:30" })).data?.next_at,
  ).toBe("2026-11-01T06:30:00.000Z");
  vi.setSystemTime(new Date("2026-11-01T06:45:00Z"));
  expect(
    (await preview({ kind: "daily", local_time: "01:30" })).data?.next_at,
  ).toBe("2026-11-02T07:30:00.000Z");
});
