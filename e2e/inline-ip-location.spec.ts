import { expect, test } from "@playwright/test";

test("IP and approximate location are visible without a reveal click", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/bids?screenshot-sizes&upload-context");
  await page.getByLabel("Found period", { exact: true }).selectOption("all");
  const cell = page.getByRole("row").filter({ has: page.getByRole("gridcell", { name: "Linear", exact: true }) }).locator('[data-field="applied_ip_location"]');
  await cell.scrollIntoViewIfNeeded();
  await expect(cell).toContainText("203.0.113.10");
  await expect(cell).toContainText("Chicago, IL, United States (US)");
  await expect(page.getByRole("button", { name: "View IP / location", exact: true })).toHaveCount(0);
});
