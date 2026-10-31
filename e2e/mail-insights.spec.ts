import { test, expect } from "@playwright/test";
import { calendarToday } from "../src/lib/calendar-period";
import type { MailInsightsReport } from "../src/lib/mail-insights-report";
const day = calendarToday();
const report: MailInsightsReport = {
  status: "ready", received_at: new Date().toISOString(), generated_at: new Date().toISOString(), range: { from: day, to: day, clipped: false },
  mailboxes: [{ email: "shared@example.test", account_label: "Shared", collected_at: null, coverage_start: null, rows: [
    { date: day, category: "application_ack", handled: true, action_required: false, retryable: false, count: 3 },
    { date: day, category: "interview_invite", handled: false, action_required: true, retryable: false, count: 2 },
  ] }],
  assignments: [
    { id: "a1", workspace_id: "w", bidder_id: "b1", bidder_name: "Alex", profile_id: "p1", profile_label: "Candidate", email: "shared@example.test", archived: false },
    { id: "a2", workspace_id: "w", bidder_id: "b2", bidder_name: "Blair", profile_id: "p1", profile_label: "Candidate", email: "shared@example.test", archived: false },
    { id: "a3", workspace_id: "w", bidder_id: "b1", bidder_name: "Alex", profile_id: "p2", profile_label: "Missing", email: "missing@example.test", archived: false },
  ],
  bid_rows: [{ date: day, workspace_id: "w", bidder_id: "b1", profile_id: "p2", assignment_id: "a3", email: "missing@example.test", found: 7, applied: 1 }],
};
test("mail filters refine only mail, tabs deduplicate shared counts, mailbox selection refreshes both reports", async ({ page }) => {
  let selectedEmail = "";
  await page.route("**/api/mail-insights/report*", route => {
    selectedEmail = new URL(route.request().url()).searchParams.get("email") ?? "";
    return route.fulfill({ json: report });
  });
  await page.goto("http://127.0.0.1:3001/dashboard");
  const section = page.getByRole("region", { name: "Email insights", exact: true });
  await section.getByRole("button", { name: "Bids and email activity", exact: true }).click();
  const table = section.getByRole("tabpanel");
  await expect(table.getByRole("row").filter({ hasText: "shared@example.test" })).toContainText("Shared mailbox");
  await expect(table.getByRole("row").filter({ hasText: "missing@example.test" })).toContainText("Not synced");
  const readsBefore = Number(await page.locator("html").getAttribute("data-report-reads"));
  await section.getByRole("combobox", { name: "Mail category", exact: true }).selectOption("interview_invite");
  const shared = table.getByRole("row").filter({ hasText: "shared@example.test" });
  await expect(shared.getByRole("cell").nth(2)).toHaveText("0");
  await expect(shared.getByRole("cell").nth(3)).toHaveText("2");
  expect(Number(await page.locator("html").getAttribute("data-report-reads"))).toBe(readsBefore);
  await section.getByRole("tab", { name: "Profile", exact: true }).click();
  await expect(section.getByRole("tabpanel", { name: "Activity by profile" })).toContainText("Candidate");
  await section.getByRole("tab", { name: "Bidder", exact: true }).click();
  await expect(section.getByRole("tabpanel")).toContainText("Alex");
  await expect(section.getByRole("tabpanel")).toContainText("Blair");
  await section.getByRole("tab", { name: "Email", exact: true }).click();
  await section.getByRole("button", { name: "shared@example.test", exact: true }).click();
  await expect.poll(() => selectedEmail).toBe("shared@example.test");
  await expect.poll(async () => Number(await page.locator("html").getAttribute("data-report-reads"))).toBeGreaterThan(readsBefore);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(section.getByRole("term").filter({ hasText: "Confirmation emails" })).toBeVisible();
  expect((await section.getByRole("tabpanel").getByRole("rowheader").first().boundingBox())?.width).toBeGreaterThanOrEqual(220);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/mail-insights/mobile.png", fullPage: true });
});
test("unavailable preview mail endpoints preserve main activity and comparisons", async ({ page }) => {
  await page.route("**/api/mail-insights/report*", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.goto("http://127.0.0.1:3001/dashboard");
  await expect(page.getByRole("alert")).toContainText("Email insights are temporarily unavailable");
  await expect(page.getByRole("heading", { name: "Application activity", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "By profile", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry email insights" })).toBeEnabled();
});
