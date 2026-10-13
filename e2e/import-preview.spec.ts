import { test, expect, type Page } from "@playwright/test";
async function preview(page: Page, query = "") {
  await page.goto(`http://127.0.0.1:3001/bids${query}`);
  await page
    .getByRole("button", { name: "Paste from Sheets", exact: true })
    .click();
  await page
    .getByLabel("Import bidder", { exact: true })
    .selectOption("bidder-0");
  await page
    .getByLabel("Import resume", { exact: true })
    .selectOption("resume-0");
  await page
    .getByLabel("Copied Google Sheets cells")
    .fill(
      "Eligible\tEngineer\thttps://preview.test/one\n\tEngineer\thttps://preview.test/two",
    );
  await page.getByRole("button", { name: "Read columns" }).click();
  await page.getByRole("button", { name: "Preview bids" }).click();
}
test("preview shows immutable values and statuses without validation reasons", async ({
  page,
}) => {
  await preview(page);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Import 1 allowed bids", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("table").locator("tbody tr").nth(0).getByRole("cell").nth(0),
  ).toHaveText("Eligible");
  await expect(dialog.getByRole("table").getByRole("textbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Remove row/ })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByText("Required; maximum 200 characters.", { exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByText("Blocked", { exact: true })).toHaveCount(1);
  await dialog
    .getByRole("button", { name: "Import 1 allowed bids", exact: true })
    .click();
  await expect(page.getByText("1 bid added", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute(
    "data-last-import-count",
    "1",
  );
});
test("all blocked rows produce no success and direct corrections back to mapping", async ({
  page,
}) => {
  await preview(page, "?block-import");
  const dialog = page.getByRole("dialog");
  const submit = dialog.getByRole("button", {
    name: "Import 0 allowed bids",
    exact: true,
  });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog.getByRole("alert")).toHaveText("No bids to add");
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-last-import-count",
    /./,
  );
  await dialog.getByRole("button", { name: "Back to mapping" }).click();
  await expect(dialog.getByLabel("Copied Google Sheets cells")).toBeEditable();
});

test("a row blocked in the first successful preview stays blocked after validation retries", async ({
  page,
}) => {
  await preview(page, "?becomes-eligible");
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Import 0 allowed bids", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Import 0 allowed bids", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText("No bids to add");
  await dialog
    .getByRole("button", { name: "Retry validation", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Import 0 allowed bids", exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByText("Blocked", { exact: true })).toHaveCount(2);
  await dialog
    .getByRole("button", { name: "Import 0 allowed bids", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText("No bids to add");
  expect(
    await page.evaluate(() => sessionStorage.getItem("import-attempts")),
  ).toBeNull();
  await dialog.getByRole("button", { name: "Back to mapping" }).click();
  await dialog.getByRole("button", { name: "Preview bids" }).click();
  await expect(
    dialog.getByRole("button", { name: "Import 1 allowed bids", exact: true }),
  ).toBeEnabled();
});
test("uncertain retries preserve every payload field and the request ID", async ({
  page,
}) => {
  await preview(page, "?lost-import");
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Import 1 allowed bids", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Import 1 allowed bids", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Connection interrupted",
  );
  await dialog
    .getByRole("button", { name: "Retry same import", exact: true })
    .first()
    .click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          JSON.parse(sessionStorage.getItem("import-attempts") ?? "[]").length,
      ),
    )
    .toBe(2);
  const attempts: string[] = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("import-attempts") ?? "[]"),
  );
  expect(attempts[1]).toBe(attempts[0]);
  expect(JSON.parse(attempts[0]).requestId).toMatch(/^[0-9a-f-]{36}$/);
});
