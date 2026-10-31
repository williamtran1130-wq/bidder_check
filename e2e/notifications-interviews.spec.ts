import { test, expect } from "@playwright/test";

test("interview performance switches between profile, bidder, and assignment groups", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/interviews");
  await expect(page.getByRole("heading", { name: "Interview performance" })).toBeVisible();
  await expect(page.getByText("Applied applications").first()).toBeVisible();
  await page.getByLabel("Group by").selectOption("bidder");
  await expect(page.getByRole("columnheader").first()).toHaveText("Bidder");
  await page.getByLabel("Group by").selectOption("assignment");
  await expect(page.getByRole("columnheader").first()).toHaveText("Profile · bidder");
});

test("clients can record interview time and notes from an applied bid", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/bids");
  await page.getByLabel("Found period").selectOption("all");
  await page.getByRole("button", { name: "Record", exact: true }).first().click();
  const dialog=page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Record interview invitation" })).toBeVisible();
  await expect(dialog.getByLabel("Interview date and time (CT)")).toBeVisible();
  await expect(dialog.getByLabel("Notes")).toBeVisible();
});
