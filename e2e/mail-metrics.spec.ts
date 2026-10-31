import { test, expect } from "@playwright/test";
import { calendarToday, shiftCalendarDate } from "../src/lib/calendar-period";
test.use({ baseURL: "http://127.0.0.1:3001" });
const day = calendarToday();
const snapshot = {
  status: "ready", received_at: new Date().toISOString(), generated_at: new Date().toISOString(), range: { from: shiftCalendarDate(day, -89), to: day, clipped: true },
  mailboxes: [{ email: "shared@example.test", account_label: "Shared", collected_at: new Date().toISOString(), coverage_start: "2020-01-01", rows: [
    { date: day, category: "application_ack", handled: true, action_required: false, retryable: false, count: 3 },
    { date: day, category: "interview_invite", handled: false, action_required: true, retryable: false, count: 2 },
  ] }],
  assignments: [{ id: "resume-1", workspace_id: "workspace", bidder_id: "bidder-1", bidder_name: "Taylor Reed", profile_id: "profile-bidder-1", profile_label: "FULLSTACK-02", email: "shared@example.test", archived: false }], bid_rows: [],
};
test.beforeEach(async ({ page }) => {
  await page.route("**/api/mail-insights/status*", route => route.fulfill({ json: { status: "not_synced", updatedAt: null, from: null, to: null } }));
  await page.route("**/api/mail-insights/report*", route => route.fulfill({ json: snapshot }));
});
test("activity collapse persists, main counts ignore section filters and only one snapshot loads", async ({ page }) => {
  let reads = 0;
  page.on("request", request => { if (request.url().includes("/api/mail-insights/report")) reads++; });
  await page.goto("/dashboard");
  const toggle = page.getByRole("button", { name: "Bids and email activity", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("tabpanel", { name: "Activity by email" })).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("tabpanel", { name: "Activity by email" })).toBeVisible();
  await expect.poll(() => reads).toBe(1);
  await page.getByRole("combobox", { name: "Mail category", exact: true }).selectOption("interview_invite");
  await expect(page.getByRole("region", { name: "By profile", exact: true }).getByLabel("FULLSTACK-02 Confirmations: 3", { exact: true })).toBeVisible();
  expect(reads).toBe(1);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});
test("Earnings preserves money and Interviews uses invitations over the available application cohort", async ({ page }) => {
  await page.goto("/earnings");
  await expect(page.getByText("Applications received", { exact: true }).first()).toBeVisible();
  const table = page.getByRole("table");
  await expect(table).toContainText("$10.00");
  await expect(table.getByRole("columnheader", { name: "Applications received", exact: true })).toBeVisible();
  await expect(table.getByRole("row").last()).toContainText("3");
  await page.goto("/interviews");
  await expect(page.getByRole("columnheader", { name: "Interview invitations", exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "FULLSTACK-02" })).toContainText("50.0%");
  await expect(page.getByRole("row").filter({ hasText: "FULLSTACK-02" }).getByRole("cell").last()).toHaveAttribute("title", `${shiftCalendarDate(day, -89)} – ${day} CT`);
  const query = JSON.parse((await page.locator("html").getAttribute("data-interview-query"))!);
  expect(query.period).toEqual({ preset: "all" });
});
test("blocked local storage keeps collapse usable and missing coverage uses plain unavailable ratios", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); });
  await page.goto("/dashboard");
  const toggle = page.getByRole("button", { name: "Bids and email activity", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.route("**/api/mail-insights/report*", route => route.fulfill({ json: { ...snapshot, mailboxes: snapshot.mailboxes.map(m => ({ ...m, coverage_start: null })) } }));
  await page.goto("/interviews");
  const row = page.getByRole("row").filter({ hasText: "FULLSTACK-02" });
  await expect(row.getByRole("cell").last()).toHaveText("—");
  await expect(page.getByRole("table")).not.toContainText(/partial|shared mailbox/i);
  await expect(page.getByRole("table")).not.toContainText("50.0%");
});

test("overview charts and exact values include invitation counts", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("img", { name: /Activity chart: .*3 confirmation emails, 2 interview invites\./ })).toBeVisible();
  await page.getByText("View activity values", { exact: true }).click();
  const table = page.getByRole("table", { name: "Activity values in Central Time" });
  await expect(table.getByRole("columnheader", { name: "Interview invites", exact: true })).toBeVisible();
  await expect(table.getByRole("row").last().getByRole("cell").last()).toHaveText("2");
  const comparison = page.getByRole("region", { name: "By profile", exact: true });
  await expect(comparison.getByLabel("FULLSTACK-02 Interview invites: 2", { exact: true })).toBeVisible();
});

test("Interview rate intersects mailbox coverage and uses first application dates in that period", async ({ page }) => {
  const yesterday = shiftCalendarDate(day, -1);
  const from = shiftCalendarDate(day, -10);
  const mail = {
    ...snapshot,
    mailboxes: [
      { ...snapshot.mailboxes[0], coverage_start: shiftCalendarDate(day, -30), rows: [
        { date: shiftCalendarDate(day, -20), category: "interview_invite", handled: false, action_required: true, retryable: false, count: 9 },
        { date: shiftCalendarDate(day, -3), category: "interview_invite", handled: false, action_required: true, retryable: false, count: 2 },
        { date: day, category: "interview_invite", handled: false, action_required: true, retryable: false, count: 7 },
      ] },
      { email: "second@example.test", account_label: "Second", coverage_start: from, collected_at: `${yesterday}T18:00:00Z`, rows: [
        { date: shiftCalendarDate(day, -2), category: "interview_invite", handled: false, action_required: true, retryable: false, count: 1 },
      ] },
    ],
    assignments: [...snapshot.assignments, { id: "resume-2", workspace_id: "workspace", bidder_id: "bidder-2", bidder_name: "Sam Rivera", profile_id: "profile-bidder-2", profile_label: "DESIGN-03", email: "second@example.test", archived: false }],
  };
  await page.route("**/api/mail-insights/report*", route => route.fulfill({ json: mail }));
  await page.goto("/interviews");
  await expect(page.getByRole("button", { name: "Refresh reports", exact: true })).toBeEnabled();
  await page.evaluate(({ yesterday, day }) => {
    window.dispatchEvent(new CustomEvent("fixture-change-bid", { detail: { id: "bid-1", patch: { first_applied_at: `${yesterday}T18:00:00Z`, applied_at: `${day}T18:00:00Z` } } }));
  }, { yesterday, day });
  await page.getByRole("button", { name: "Refresh reports", exact: true }).click();
  await expect(page.getByText("300.0%", { exact: true })).toHaveAttribute("title", `${from} – ${yesterday} CT`);
  const row = page.getByRole("row").filter({ hasText: "FULLSTACK-02" });
  await expect(row.getByRole("cell")).toHaveText(["FULLSTACK-02", "1", "2", "200.0%"]);
  await expect(page.getByLabel("Report period", { exact: true })).toHaveValue("all");
  await expect(page.getByRole("table")).not.toContainText(/partial|shared mailbox/i);
});

test("a seeded report performs one read and stays fresh through 269 seconds of focus", async ({ page }) => {
  let reads = 0;
  page.on("request", request => { if (request.url().includes("/api/mail-insights/report")) reads++; });
  await page.clock.install({ time: new Date() });
  await page.goto("/dashboard?report-seed&report-strict");
  await expect(page.getByRole("img", { name: /Activity chart: .*2 interview invites\./ })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-report-reads", "1");
  await page.clock.fastForward(269000);
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(10);
  expect(reads).toBe(1);
  await expect(page.locator("html")).toHaveAttribute("data-report-reads", "1");
  await page.clock.fastForward(1100);
  await page.evaluate(() => { for (let i = 0; i < 4; i++) window.dispatchEvent(new Event("focus")); });
  await page.clock.runFor(10);
  await expect.poll(() => reads).toBe(2);
  await expect(page.locator("html")).toHaveAttribute("data-report-reads", "2");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(3 * 24 * 60 * 60 * 1000);
  await page.clock.runFor(10);
  expect(reads).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(10);
  await expect.poll(() => reads).toBe(3);
});
