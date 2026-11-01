import { expect, test } from "@playwright/test";
import { calendarToday, shiftCalendarDate } from "../src/lib/calendar-period";

test.use({ baseURL: "http://127.0.0.1:3001" });
test.beforeEach(async ({ page }) => {
  const day = calendarToday();
  await page.route("**/api/mail-insights/status*", route => route.fulfill({ json: { status: "not_synced", updatedAt: null, from: null, to: null } }));
  await page.route("**/api/mail-insights/report*", route => route.fulfill({ json: {
    status: "ready", received_at: new Date().toISOString(), generated_at: new Date().toISOString(),
    range: { from: shiftCalendarDate(day, -89), to: day, clipped: true },
    assignments: [{ id: "resume-1", workspace_id: "workspace", bidder_id: "bidder-1", bidder_name: "Taylor Reed", profile_id: "profile-bidder-1", profile_label: "FULLSTACK-02", email: "bidder1@example.test", archived: false }],
    mailboxes: [{ email: "bidder1@example.test", account_label: "Candidate", collected_at: new Date().toISOString(), coverage_start: "2020-01-01", rows: [{ date: day, category: "interview_invite", handled: false, action_required: true, retryable: false, count: 2 }] }], bid_rows: [],
  } }));
});

test("archived identities leave dashboard totals intact and disappear from comparisons and choices", async ({ page }) => {
  await page.goto("/dashboard");
  const summary = page.getByRole("region", { name: "Dashboard summary", exact: true });
  await expect(summary.getByRole("group", { name: "Earned", exact: true })).toContainText("$10.00");
  const totals = await summary.textContent();
  await page.goto("/dashboard?inactive-items");
  await expect(summary).toHaveText(totals!);
  const bidders = page.getByRole("region", { name: "By bidder", exact: true });
  await expect(bidders).not.toContainText("Jamie Parker");
  await expect(bidders).not.toContainText("Taylor Reed");
  await expect(bidders).toContainText("Sam Rivera");
  const profiles = page.getByRole("region", { name: "By profile", exact: true });
  await expect(profiles).not.toContainText("ENG-01");
  await expect(profiles).not.toContainText("FULLSTACK-02");
  await expect(profiles).toContainText("DESIGN-03");
  await expect(page.getByLabel("Bidder", { exact: true }).locator('option[value="bidder-0"]')).toHaveCount(0);
  await expect(page.getByLabel("Candidate profile", { exact: true }).locator('option[value="profile-bidder-1"]')).toHaveCount(0);
});

test("bid filters and new-bid picker exclude inactive ancestry while historical bids remain", async ({ page }) => {
  await page.goto("/bids?inactive-items");
  await page.getByLabel("Found period").selectOption("all");
  await expect(page.locator('[data-field="company"]').first()).toBeVisible();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await expect(page.getByLabel("Bidder", { exact: true }).locator('option[value="bidder-0"]')).toHaveCount(0);
  await page.getByLabel("Resume", { exact: true }).click();
  const list = page.getByRole("listbox", { name: "Resume assignments" });
  await expect(list.getByRole("option")).toHaveCount(2);
  await expect(list).not.toContainText("Jamie Parker");
  await expect(list).not.toContainText("Taylor Reed");
  await expect(list).toContainText("Sam Rivera");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add bid", exact: true }).click();
  await expect(page.getByLabel("Resume profile").locator("option:not([disabled])")).toHaveCount(1);
  await expect(page.getByLabel("Resume profile").locator("option:not([disabled])")).toContainText("Sam Rivera");
});

test("earnings and invitation totals survive hidden historical groups", async ({ page }) => {
  await page.goto("/earnings?inactive-items");
  await expect(page.getByText("Total earned", { exact: true }).locator("..")).toContainText("$10.00");
  await expect(page.getByRole("main")).not.toContainText("Taylor Reed");
  await expect(page.getByRole("main")).not.toContainText("FULLSTACK-02");
  await page.goto("/interviews?inactive-items");
  await expect(page.getByText("Interview invitations", { exact: true }).first().locator("..")).toContainText("2");
  await expect(page.getByRole("table")).not.toContainText("FULLSTACK-02");
});
