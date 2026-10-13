import { test, expect, type Page } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:3001" });
test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === "http://127.0.0.1:3001"
      ? route.continue()
      : route.abort(),
  );
});

async function pasteFromCell(page: Page) {
  const cell = page
    .locator('[data-field="company"]')
    .filter({ hasText: "Linear" });
  await cell.click();
  await cell.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.setData(
      "text/plain",
      "New Company\tEngineer\thttps://preview.test/new-company",
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, clipboardData: clipboard }),
    );
  });
  await expect(page.getByRole("dialog")).toBeVisible();
  return cell;
}

async function preview(page: Page) {
  const bidder = page.getByLabel("Import bidder", { exact: true });
  if (await bidder.isEnabled()) await bidder.selectOption("bidder-0");
  else await expect(bidder).toHaveValue("bidder-0");
  await page
    .getByLabel("Import resume", { exact: true })
    .selectOption("resume-0");
  await page.getByRole("button", { name: "Read columns", exact: true }).click();
  await page.getByRole("button", { name: "Preview bids", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Import 1 allowed bids", exact: true }),
  ).toBeEnabled();
}

for (const path of ["/bids", "/scoped-admin"]) {
  test(`successful cell-origin import returns focus to the stable launcher in ${path}`, async ({
    page,
  }) => {
    await page.goto(path);
    const cell = await pasteFromCell(page);
    const origin = await cell.elementHandle();
    await preview(page);
    await page
      .getByRole("button", { name: "Import 1 allowed bids", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute(
      "data-last-import-count",
      "1",
    );
    await expect
      .poll(() => origin!.evaluate((element) => element.isConnected))
      .toBe(false);
    await expect(
      page.getByRole("button", { name: "Paste from Sheets", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test(`Escape after origin row removal returns focus to the stable launcher in ${path}`, async ({
    page,
  }) => {
    await page.goto(path);
    const cell = await pasteFromCell(page);
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("fixture-change-bid", {
          detail: {
            id: "bid-0",
            patch: { deleted_at: "2026-10-13T12:00:00Z" },
          },
        }),
      );
      window.dispatchEvent(new Event("focus"));
    });
    await expect(cell).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Paste from Sheets", exact: true }),
    ).toBeFocused();
  });
}

test("ordinary launcher and surviving cell both regain focus on cancellation", async ({
  page,
}) => {
  await page.goto("/bids");
  const launcher = page.getByRole("button", {
    name: "Paste from Sheets",
    exact: true,
  });
  await launcher.click();
  await page.keyboard.press("Escape");
  await expect(launcher).toBeFocused();
  const cell = await pasteFromCell(page);
  await page.keyboard.press("Escape");
  await expect(cell).toBeFocused();
});

test("native preview cell names include imported values and headers describe the table", async ({
  page,
}) => {
  await page.goto("/bids");
  await pasteFromCell(page);
  await preview(page);
  const table = page.getByRole("dialog").getByRole("table");
  for (const value of [
    "New Company",
    "Engineer",
    "https://preview.test/new-company",
  ]) {
    const cell = table.getByRole("cell", { name: value, exact: true });
    await expect(cell).toHaveText(value);
    await expect(cell).toMatchAriaSnapshot(`- cell "${value}"`);
  }
  await expect(
    table.getByRole("columnheader", { name: "Company", exact: true }),
  ).toHaveAttribute("scope", "col");
  await expect(
    table.getByRole("rowheader", { name: "1", exact: true }),
  ).toHaveAttribute("scope", "row");
});

test("uncertain import still prevents Escape, outside dismissal and Close", async ({
  page,
}) => {
  await page.goto("/bids?lost-import");
  await pasteFromCell(page);
  await preview(page);
  await page
    .getByRole("button", { name: "Import 1 allowed bids", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Retry keeps the same request and will not duplicate bids.",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close", exact: true }),
  ).toHaveCount(0);
  await page.mouse.click(1, 1);
  await expect(page.getByRole("dialog")).toBeVisible();
  const attempts = await page.evaluate(() =>
    sessionStorage.getItem("import-attempts"),
  );
  expect(JSON.parse(attempts!)).toHaveLength(1);
});
