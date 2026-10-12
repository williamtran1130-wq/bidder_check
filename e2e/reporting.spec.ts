import { test, expect } from "@playwright/test";

const preview = "http://127.0.0.1:3001";
const periods = ["Today", "Yesterday", "This week", "Last week", "This month", "Last month", "All time", "Custom range"];

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-12T17:00:00Z"));
});

test("calendar filters share defaults and Monday through Sunday weeks", async ({ page }) => {
  await page.goto(`${preview}/dashboard`);
  const period = page.getByLabel("Period", { exact: true });
  await expect(period).toHaveValue("this_month");
  await expect(period.locator("option")).toHaveText(periods);
  await period.selectOption("last_week");
  await expect(page.getByText("2026-10-05 – 2026-10-11 CT", { exact: true })).toBeVisible();
  await period.selectOption("this_week");
  await expect(page.getByText("2026-10-12 – 2026-10-12 CT", { exact: true })).toBeVisible();
  await page.goto(`${preview}/interviews`);
  await expect(page.getByLabel("Cohort period", { exact: true })).toHaveValue("this_month");
  await page.goto(`${preview}/earnings`);
  await expect(page.getByLabel("First applied period", { exact: true })).toHaveValue("all");
  await page.goto(`${preview}/bids`);
  await expect(page.getByLabel("Found period", { exact: true })).toHaveValue("today");
  await page.getByLabel("Found period", { exact: true }).selectOption("all");
  await page.getByRole("button", { name: "Filter Added date (CT)", exact: true }).click();
  const column = page.getByLabel("Added date (CT) period", { exact: true });
  await expect(column.locator("option")).toHaveText(periods);
  await column.selectOption("yesterday");
  await expect(page.getByText("1–1 of 1 bids", { exact: true })).toBeVisible();
});

test("custom dates stay drafts until valid and explicitly applied", async ({ page }) => {
  await page.goto(`${preview}/dashboard`);
  await expect(page.locator("html")).toHaveAttribute("data-report-reads", "1");
  await expect(page.getByRole("img", { name: "Activity chart: 12 found, 8 applications." })).toBeVisible();
  await page.getByLabel("Period", { exact: true }).selectOption("custom");
  await page.getByLabel("Period from CT", { exact: true }).fill("");
  await expect(page.getByRole("button", { name: "Apply range", exact: true })).toBeDisabled();
  await page.getByLabel("Period from CT", { exact: true }).fill("2026-10-12");
  await page.getByLabel("Period through CT", { exact: true }).fill("2026-10-01");
  await expect(page.getByRole("button", { name: "Apply range", exact: true })).toBeDisabled();
  await expect(page.locator("html")).toHaveAttribute("data-report-reads", "1");
  await page.getByLabel("Period through CT", { exact: true }).fill("2026-10-12");
  await page.getByRole("button", { name: "Apply range", exact: true }).click();
  await expect(page.getByRole("img", { name: "Activity chart: 1 found, 0 applications." })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-report-reads", "2");
});

test("failed refresh keeps only same-filter results and retries once", async ({ page }) => {
  await page.goto(`${preview}/dashboard?report-failure`);
  const existing = page.getByRole("img", { name: "Activity chart: 12 found, 8 applications." });
  await expect(existing).toBeVisible();
  await page.getByRole("button", { name: "Refresh dashboard" }).click();
  await expect(page.getByRole("alert")).toContainText("Showing the last successful results for these filters.");
  await expect(existing).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-report-reads", "3");
  await page.getByLabel("Period", { exact: true }).selectOption("today");
  await expect(existing).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("This report is temporarily unavailable. Please retry.");
  await expect(page.getByRole("alert")).not.toContainText("last successful");
  await expect(page.locator("html")).toHaveAttribute("data-report-reads", "5");
  await expect(page.getByText("Activity unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByText(/statement timeout|canceling statement|No bids found/)).toHaveCount(0);
});

test("a late response cannot replace a newly selected period", async ({ page }) => {
  await page.goto(`${preview}/dashboard?report-delay`);
  await expect(page.locator("html")).toHaveAttribute("data-report-reads", "1");
  await page.getByLabel("Period", { exact: true }).selectOption("today");
  await expect(page.getByRole("img", { name: "Activity chart: 1 found, 0 applications." })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-report-completed", "this_month");
  await expect(page.getByRole("img", { name: "Activity chart: 1 found, 0 applications." })).toBeVisible();
});

test("overlapping focus refreshes reuse the request already in flight", async ({ page }) => {
  await page.goto(`${preview}/dashboard?report-delay`);
  await expect(page.locator("html")).toHaveAttribute("data-report-reads", "1");
  await page.evaluate(() => { for (let i = 0; i < 4; i++) window.dispatchEvent(new Event("focus")); });
  await expect(page.getByRole("img", { name: "Activity chart: 12 found, 8 applications." })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-report-reads", "1");
});

test("bidder overview omits money and teammates and keeps accessible profile values", async ({ page }) => {
  await page.goto(`${preview}/dashboard?role=bidder`);
  await expect(page.getByRole("heading", { name: "By profile", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "By bidder", exact: true })).toHaveCount(0);
  await expect(page.getByText(/Earned|earnings|Saved rate|\$\d/)).toHaveCount(0);
  await expect(page.locator('a[href="/earnings"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add bid", exact: true })).toHaveCount(0);
  await page.getByText("View all comparison values", { exact: true }).click();
  await expect(page.getByRole("table", { name: "By profile values" })).toContainText("ENG-01");
  await expect(page.getByRole("table", { name: "By profile values" })).not.toContainText("FULLSTACK-02");
  await page.goto(`${preview}/resumes?role=bidder`);
  await expect(page.getByText(/Default rate|Rate override|per application|\$\d/)).toHaveCount(0);
  await page.goto(`${preview}/bids?role=bidder`);
  await page.getByRole("button", { name: "View Senior Frontend Engineer at Linear" }).click();
  await expect(page.getByRole("dialog").getByText(/Saved rate|\$\d/)).toHaveCount(0);
});

test("relative report filters refresh at CT midnight", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-13T04:59:50Z") });
  await page.goto(`${preview}/dashboard`);
  await page.getByLabel("Period", { exact: true }).selectOption("today");
  await expect(page.getByText("2026-10-12 – 2026-10-12 CT", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Activity chart: 1 found, 0 applications." })).toBeVisible();
  await page.clock.fastForward(11000);
  await expect(page.getByText("2026-10-13 – 2026-10-13 CT", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Activity chart: 0 found, 0 applications." })).toBeVisible();
});

test("bid date rollover defers while editing then refreshes on exit", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-13T04:59:50Z") });
  await page.goto(`${preview}/bids`);
  const cell = page.locator('[data-grid-r="0"][data-field="company"]');
  await cell.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit company", exact: true });
  await editor.fill("Keep my draft");
  await page.clock.fastForward(16000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(editor).toHaveValue("Keep my draft");
  await editor.press("Escape");
  await expect(page.getByText("0–0 of 0 bids", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Found period", { exact: true })).toHaveValue("today");
});

test("idle bid filters refresh at CT midnight without waiting for focus", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-13T04:59:50Z") });
  await page.goto(`${preview}/bids`);
  await expect(page.getByText("1–1 of 1 bids", { exact: true })).toBeVisible();
  await page.clock.pauseAt(new Date("2026-10-13T04:59:55Z"));
  await page.clock.runFor(5100);
  await expect(page.getByText("0–0 of 0 bids", { exact: true })).toBeVisible();
});

test("single creation eligibility rejection shows only Blocked", async ({ page }) => {
  await page.goto(`${preview}/bids?single-blocked`);
  await page.getByRole("button", { name: "Add bid", exact: true }).click();
  await page.getByLabel("Job URL", { exact: true }).fill("https://example.com/blocked");
  await page.getByLabel("Company name", { exact: true }).fill("Acme");
  await page.getByLabel("Role name", { exact: true }).fill("Engineer");
  await page.getByLabel("Jobsite source", { exact: true }).fill("Company website");
  await page.getByRole("button", { name: "Add opportunity", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText("Blocked");
  await expect(page.getByText(/Opportunity added|company limit|restricted|duplicate/i)).toHaveCount(0);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("a failed new bid period never shows the previous period's rows or zero totals", async ({ page }) => {
  await page.goto(`${preview}/bids?refresh-failure`);
  await expect(page.getByRole("gridcell", { name: "Linear", exact: true })).toBeVisible();
  await page.getByLabel("Found period").selectOption("yesterday");
  await expect(page.getByRole("alert")).toContainText("Refresh unavailable");
  await expect(page.getByRole("gridcell", { name: "Linear", exact: true })).toHaveCount(0);
  await expect(page.getByText("Bid results could not be loaded. Use Retry above to try again.")).toBeVisible();
  await expect(page.getByText("Results unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText(/0–0 of 0 bids|1–1 of 1 bids/)).toHaveCount(0);
});

test("a pending search waits for an active grid edit before changing results", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-12T17:00:00Z") });
  await page.goto(`${preview}/bids`);
  await expect(page.getByText("1–1 of 1 bids", { exact: true })).toBeVisible();
  await page.clock.pauseAt(new Date("2026-10-12T17:00:05Z"));
  await page.getByRole("textbox", { name: "Search bids", exact: true }).fill("nothing matches");
  await page.locator('[data-grid-r="0"][data-field="company"]').dblclick();
  const editor = page.getByRole("textbox", { name: "Edit company", exact: true });
  await editor.fill("Preserve this draft");
  await expect(page.getByLabel("Rows per page", { exact: true })).toBeDisabled();
  await page.clock.runFor(300);
  await expect(editor).toHaveValue("Preserve this draft");
  await editor.press("Escape");
  await expect(page.getByText("0–0 of 0 bids", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Found period")).toBeEnabled();
});
