import { test, expect } from "@playwright/test";
test("500-row preview remains usable with Unicode, quoted multiline values", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids");
  await page
    .getByRole("button", { name: "Paste from Sheets", exact: true })
    .click();
  await page
    .getByLabel("Import bidder", { exact: true })
    .selectOption("bidder-0");
  await page
    .getByLabel("Import resume", { exact: true })
    .selectOption("resume-0");
  const clipboard = Array.from(
    { length: 500 },
    (_, i) =>
      `"\u6771\u4eac ${i}"\t"Engineer\nMultiline"\thttps://example.com/jobs/${i}`,
  ).join("\n");
  await page.getByLabel("Copied Google Sheets cells").fill(clipboard);
  await page.getByRole("button", { name: "Read columns" }).click();
  await page.getByRole("button", { name: "Preview bids" }).click();
  await expect(
    page.getByRole("button", { name: "Import 500 allowed bids", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("dialog").getByRole("table").locator("tbody tr").nth(499).getByRole("cell").nth(0),
  ).toHaveText("\u6771\u4eac 499");
  await expect(page.getByRole("button", { name: /Remove row/ })).toHaveCount(0);
  await expect(page.getByRole("table").getByRole("textbox")).toHaveCount(0);
});
test("an admin import scoped to a bidder keeps the workspace and bidder fixed", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/scoped-admin");
  await page
    .getByRole("button", { name: "Paste from Sheets", exact: true })
    .click();
  await expect(
    page.getByLabel("Client workspace", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Import bidder", { exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Import resume", { exact: true })
    .selectOption("resume-0");
  await expect(page.getByLabel("Import resume", { exact: true })).toHaveValue(
    "resume-0",
  );
});
