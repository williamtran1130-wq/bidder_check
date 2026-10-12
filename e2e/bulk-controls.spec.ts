import { test, expect } from "@playwright/test";
test("checkbox selection spans pages, remains separate from cells and resets on filters", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids");
  await page.getByLabel("Found period").selectOption("all");
  await page.getByRole("checkbox", { name: "Select current page" }).check();
  await expect(page.getByText("10 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select current page" }).check();
  await expect(page.getByText("12 selected", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Move selected to trash", exact: true })
    .click();
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Select current page" }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: "Select current page" }).check();
  await page
    .getByRole("button", { name: "Delete selected permanently", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Permanently delete", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await expect(
    page.getByRole("button", { name: "Permanently delete", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByLabel("Found period").selectOption("today");
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();
});
test("Sheets import has data-only mapping and only arrangement/status defaults", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids");
  await page
    .getByRole("button", { name: "Paste from Sheets", exact: true })
    .click();
  await expect(page.getByLabel("Default company", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Default role", { exact: true })).toHaveCount(0);
  await expect(
    page.getByLabel("Default job site", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("First row contains headers")).toHaveCount(0);
  await expect(page.getByLabel("Default work arrangement")).toHaveValue(
    "remote",
  );
  await expect(page.getByText(/paste without headings/i)).toBeVisible();
});

test("failed background refresh keeps the grid and its toolbar position", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids?refresh-failure");
  const cell = page.getByRole("gridcell", { name: "Linear", exact: true });
  await expect(cell).toBeVisible();
  const before = await cell.boundingBox();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Refresh unavailable");
  await expect(cell).toBeVisible();
  // Errors are actionable; routine successful refreshes never mount extra rows.
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Refreshing bids...", { exact: true }),
  ).toHaveCount(0);
  expect(before?.height).toBe((await cell.boundingBox())?.height);
});

test("cleanup notice counts down, enables retry only when due and then shows completion", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids?purge-notice");
  const notice = page
    .getByRole("status")
    .filter({ hasText: "15 applications deleted" });
  const retry = notice.getByRole("button", { name: "Retry cleanup" });
  await expect(notice).toContainText(
    "Screenshots removed — final verification scheduled in",
  );
  await expect(notice).not.toContainText(/remaining/i);
  await expect(retry).toBeDisabled();
  await expect(notice).toContainText("Verifying cleanup (1 file)");
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(notice).toContainText("Cleanup complete");
  await expect(notice).toHaveCount(0, { timeout: 15000 });
});

test("empty results keep headers and portaled filters visible", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/bids");
  await page.getByLabel("Found period").selectOption("all");
  await page.getByRole("button", { name: "Filter Company name" }).click();
  await page.getByLabel("Company name filter").fill("no company matches this");
  await expect(page.getByText("0–0 of 0 bids")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Company name" })).toBeVisible();
  const filter = page.getByLabel("Company name filter");
  await expect(filter).toBeVisible();
  const box = await filter.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
  await page.getByRole("button", { name: "Clear filter" }).click();
  await page.getByRole("textbox", { name: "Search bids" }).fill("nothing matches");
  await expect(page.getByText("0–0 of 0 bids")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Company name" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter Company name" })).toBeVisible();
});

test("managers can explicitly mark selected bids applied in one confirmation", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/bids?manual-apply");
  await page.getByRole("checkbox", { name: "Select bid at Linear" }).check();
  await page.getByRole("button", { name: "Mark selected as applied" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Mark selected bids as applied?" })).toBeVisible();
  await expect(dialog.getByLabel("Applied date and time (CT)")).toHaveValue(/.+/);
  await dialog.getByLabel("Reason (required)").fill("Confirmed with the hiring team");
  await dialog.getByRole("button", { name: "Confirm application" }).click();
  await expect(page.getByText(/1 applications marked applied/)).toBeVisible();
});
