import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const fixture = "http://127.0.0.1:3001";
test.use({ baseURL: fixture });
async function open(page: Page, flags = "", route = "/bids") {
  await page.goto(`${route}?screenshot-sizes&upload-context&${flags}`);
  await expect(
    page.getByRole("grid", { name: "Bid applications", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Found period", { exact: true }).selectOption("all");
}
const cells = (page: Page) =>
  page.locator('[data-field="applied_ip_location"]');
const linear = (page: Page) =>
  page
    .getByRole("row")
    .filter({
      has: page.getByRole("gridcell", { name: "Linear", exact: true }),
    });
for (const role of ["client", "admin", "bidder"]) {
  test(`${role} sees inline application location without metadata requests`, async ({
    page,
  }) => {
    const metadataRequests: string[] = [];
    page.on("request", (request) => {
      if (/upload-context|upload-history/.test(new URL(request.url()).pathname))
        metadataRequests.push(request.url());
    });
    await open(page, role === "client" ? "" : `role=${role}`);
    const headings = await page.getByRole("columnheader").allTextContents();
    expect(
      headings[headings.findIndex((text) => text.trim() === "Screenshot") + 1],
    ).toBe("Applied IP / location");
    await expect(
      linear(page).locator('[data-field="applied_ip_location"]'),
    ).toContainText("203.0.113.10");
    await expect(linear(page)).toContainText("Chicago, IL, United States (US)");
    expect(metadataRequests).toEqual([]);
    if (role === "bidder")
      await expect(
        page.getByRole("button", {
          name: "Open screenshot for Linear",
          exact: true,
        }),
      ).toHaveCount(0);
  });
}
test("US is green, non-US and unknown are amber, and unapplied is neutral with readable labels", async ({
  page,
}) => {
  await open(page);
  await expect(linear(page)).toHaveAttribute("data-application-location", "us");
  await expect(
    cells(page).filter({ hasText: "Applied from outside United States" }),
  ).toHaveCount(1);
  await expect(
    cells(page).filter({ hasText: "Applied country unknown" }),
  ).toHaveCount(1);
  await expect(cells(page).filter({ hasText: "Not applied" })).toHaveCount(1);
  await expect(
    page.locator('tr[data-application-location="warning"]'),
  ).toHaveCount(2);
  await expect(
    page.locator('tr[data-application-location="neutral"]'),
  ).toHaveCount(1);
  const cell = linear(page).locator('[data-field="applied_ip_location"]');
  await cell.scrollIntoViewIfNeeded();
  const scan = await new AxeBuilder({ page })
    .include("[data-applied-ip-location]")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(
    scan.violations.filter((issue) =>
      ["serious", "critical"].includes(issue.impact ?? ""),
    ),
  ).toEqual([]);
});
test("country single select filters and clears pagination and selection while keeping all country options", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Previous page", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("row")
    .filter({
      has: page.getByRole("gridcell", { name: "Applied from United States" }),
    })
    .first()
    .getByRole("checkbox")
    .check();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const country = page.getByLabel("Application country", { exact: true });
  await country.selectOption("CA");
  await expect(cells(page)).toHaveCount(1);
  await expect(cells(page)).toContainText("Canada (CA)");
  await expect(
    page.getByRole("button", { name: "Previous page", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
  expect(await country.locator("option").allTextContents()).toEqual([
    "All countries",
    "United States (US)",
    "Non-US",
    "Unknown",
    "Canada (CA)",
  ]);
  await country.selectOption("unknown");
  await expect(cells(page)).toHaveCount(2);
  await country.selectOption("non-US");
  await expect(cells(page)).toHaveCount(1);
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(country).toHaveValue("all");
});
test("correction and screenshot expiry preserve saved IP and country filtering while unapplied rows are neutral", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("fixture-change-bid", {
        detail: {
          id: "bid-0",
          patch: { applied: false, evidence_file_id: null, version: 1 },
        },
      }),
    ),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(linear(page)).toHaveAttribute(
    "data-application-location",
    "neutral",
  );
  await expect(linear(page)).toContainText("203.0.113.10");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page
    .getByLabel("Application country", { exact: true })
    .selectOption("US");
  await expect(linear(page)).toBeVisible();
  await expect(linear(page)).toContainText("United States (US)");
});
test("historical and unavailable locations remain unknown without copy controls", async ({
  page,
}) => {
  await open(page, "upload-context-old");
  await expect(linear(page)).toContainText("Location not recorded");
  await expect(
    linear(page).getByRole("button", { name: "Copy IP address" }),
  ).toHaveCount(0);
  await open(page, "upload-context-unavailable");
  await expect(linear(page)).toContainText("IP unavailable");
  await expect(linear(page)).toContainText("Applied country unknown");
});

test("cell selection and keyboard focus override the row country tint", async ({ page }) => {
  await open(page);
  const row = linear(page);
  const company = row.getByRole("gridcell", { name: "Linear", exact: true });
  await company.scrollIntoViewIfNeeded(); await company.click();
  await expect(company).toHaveAttribute("aria-selected", "true");
  await expect(company).toBeFocused();
  const colors = await company.evaluate(cell => ({cell: getComputedStyle(cell).backgroundColor, row: getComputedStyle(cell.parentElement!).backgroundColor}));
  expect(colors.cell).not.toBe("rgba(0, 0, 0, 0)"); expect(colors.cell).not.toBe(colors.row);
});
