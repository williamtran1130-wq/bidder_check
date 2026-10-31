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
  assignments: [{ id: "resume-1", workspace_id: "workspace-1", bidder_id: "bidder-0", bidder_name: "Jamie Parker", profile_id: "profile-0", profile_label: "ENG-01", email: "shared@example.test", archived: false }], bid_rows: [],
};
test.beforeEach(async ({ page }) => { await page.route("**/api/mail-insights/report*", route => route.fulfill({ json: snapshot })); });
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
  await expect(page.getByRole("region", { name: "By profile", exact: true })).toContainText("Confirmations 3");
  expect(reads).toBe(1);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});
test("Earnings shows received messages without changing money; Interviews uses mail instead of flags", async ({ page }) => {
  await page.goto("/earnings");
  await expect(page.getByText("Applications received", { exact: true }).first()).toBeVisible();
  const table = page.getByRole("table");
  await expect(table).toContainText("$10.00");
  await expect(table.getByRole("columnheader", { name: "Applications received", exact: true })).toBeVisible();
  await expect(table.getByRole("row").last()).toContainText("3");
  await page.goto("/interviews");
  await expect(page.getByText("Invitation emails / applications", { exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "ENG-01" })).toContainText("200.0%");
  const query = JSON.parse((await page.locator("html").getAttribute("data-interview-query"))!);
  expect(query.period).toEqual({ preset: "custom", from: shiftCalendarDate(day, -89), to: day });
});
test("blocked local storage keeps collapse usable and incomplete coverage suppresses ratios", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); });
  await page.goto("/dashboard");
  const toggle = page.getByRole("button", { name: "Bids and email activity", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.route("**/api/mail-insights/report*", route => route.fulfill({ json: { ...snapshot, mailboxes: snapshot.mailboxes.map(m => ({ ...m, coverage_start: null })) } }));
  await page.goto("/interviews");
  await expect(page.getByRole("table")).toContainText("(partial)");
  await expect(page.getByRole("table")).not.toContainText("200.0%");
});
