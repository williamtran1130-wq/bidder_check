import { test, expect } from "@playwright/test";
const origin = "http://127.0.0.1:3001";
test("permanent deletion requires confirmation and removes the row without a trash stage", async ({
  page,
}) => {
  await page.goto(`${origin}/bids`);
  await page.getByLabel("Found period").selectOption("all");
  await page
    .getByRole("checkbox", { name: "Select bid at Linear", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Delete selected permanently", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Permanently delete", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await page
    .getByRole("button", { name: "Permanently delete", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "Select bid at Linear", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Trash", exact: true }),
  ).toHaveCount(0);
});
test("a stale deletion preserves selected rows and presents a refresh error", async ({
  page,
}) => {
  await page.goto(`${origin}/bids?deletion-conflict`);
  await page.getByLabel("Found period").selectOption("all");
  await page
    .getByRole("checkbox", { name: "Select bid at Linear", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Delete selected permanently", exact: true })
    .click();
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await page
    .getByRole("button", { name: "Permanently delete", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "changed",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Select bid at Linear", exact: true }),
  ).toBeChecked();
});
