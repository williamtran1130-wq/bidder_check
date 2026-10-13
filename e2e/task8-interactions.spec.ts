import { test, expect } from "@playwright/test";
test.use({ baseURL: "http://127.0.0.1:3001" });
test.beforeEach(async ({ page }) => {
  await page.route("**/*", (r) =>
    new URL(r.request().url()).origin === "http://127.0.0.1:3001"
      ? r.continue()
      : r.abort(),
  );
});
test("clear filters restores Today after custom range", async ({ page }) => {
  await page.goto("/bids");
  await page.getByLabel("Found period", { exact: true }).selectOption("custom");
  await page.getByLabel("Found period from CT").fill("2026-01-01");
  await page.getByLabel("Found period through CT").fill("2026-01-02");
  await page.getByRole("button", { name: "Apply range", exact: true }).click();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(page.getByLabel("Found period", { exact: true })).toHaveValue(
    "today",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
});
test("column filter keeps focus and characters as query changes", async ({
  page,
}) => {
  await page.goto("/bids");
  await page
    .getByRole("button", { name: "Filter Company name", exact: true })
    .click();
  const filter = page.getByLabel("Company name filter", { exact: true });
  await filter.pressSequentially("Linear", { delay: 30 });
  await expect(filter).toHaveValue("Linear");
  await expect(filter).toBeFocused();
});
test("selection follows a row through refresh and clears across pages; bulk targets stay separate", async ({
  page,
}) => {
  await page.goto("/bids");
  await page.getByLabel("Found period", { exact: true }).selectOption("all");
  const cell = page
    .locator('[data-field="company"]')
    .filter({ hasText: "Linear" });
  await cell.click();
  await page.getByLabel("Select bid at Linear", { exact: true }).check();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(cell).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    page.locator('[data-field="company"][aria-selected="true"]'),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  await expect(
    page.getByLabel("Select bid at Linear", { exact: true }),
  ).toBeChecked();
});
test("import preview reflows, is keyboard reachable, and close restores focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/bids?block-import");
  const launcher = page.getByRole("button", {
    name: "Paste from Sheets",
    exact: true,
  });
  await launcher.click();
  await page
    .getByLabel("Import bidder", { exact: true })
    .selectOption("bidder-0");
  await page
    .getByLabel("Import resume", { exact: true })
    .selectOption("resume-0");
  await page
    .getByLabel("Copied Google Sheets cells")
    .fill("Acme\tEngineer\thttps://preview.test/job");
  await page.getByRole("button", { name: "Read columns" }).click();
  await page.getByRole("button", { name: "Preview bids" }).click();
  await expect(page.getByText("Blocked", { exact: true })).toBeVisible();
  const region = page.getByRole("region", {
    name: "Import preview, scroll horizontally for all columns",
  });
  await expect(region).toHaveAttribute("tabindex", "0");
  await expect
    .poll(() =>
      page
        .getByRole("dialog")
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(launcher).toBeFocused();
});
test("password visibility has a touch target and decorative motion is not created with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/auth/login");
  const button = page.getByRole("button", { name: "Show password" });
  const box = await button.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  expect(box!.height).toBeGreaterThanOrEqual(24);
  await button.click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await expect(
    page.locator('linearGradient[id^="linearGradient-"]'),
  ).toHaveCount(0);
});
test("late history response never appears under another bid", async ({
  page,
}) => {
  await page.goto("/bids?history-race");
  await page.getByLabel("Found period", { exact: true }).selectOption("all");
  await page
    .getByRole("button", {
      name: "View Senior Frontend Engineer at Linear",
      exact: true,
    })
    .click();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", {
      name: "View Full Stack Developer at Notion",
      exact: true,
    })
    .click();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("fixture-history-resolve-bid-1")),
  );
  await expect(
    page.getByText("History for bid-1", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("fixture-history-resolve-bid-0")),
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
      ),
  );
  await expect(
    page.getByText("History for bid-0", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("History for bid-1", { exact: true }),
  ).toBeVisible();
});
test("action transport error stays local and keeps form draft", async ({
  page,
}) => {
  await page.goto("/bids?transport-failure");
  await page.getByRole("button", { name: "Add bid", exact: true }).click();
  await page
    .getByLabel("Job URL", { exact: true })
    .fill("https://preview.test/draft");
  await page.getByLabel("Company name", { exact: true }).fill("Draft company");
  await page.getByLabel("Role name", { exact: true }).fill("Engineer");
  await page
    .getByLabel("Jobsite source", { exact: true })
    .fill("Company website");
  await page
    .getByRole("button", { name: "Add opportunity", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Could not complete this action",
  );
  await expect(page.getByLabel("Company name", { exact: true })).toHaveValue(
    "Draft company",
  );
});
test("cell selection follows row identity when server order changes", async ({
  page,
}) => {
  await page.goto("/bids");
  await page.getByLabel("Found period", { exact: true }).selectOption("all");
  const company = page
    .locator('[data-field="company"]')
    .filter({ hasText: "Notion" });
  await company.click();
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("fixture-change-bid", {
        detail: {
          id: "bid-1",
          patch: { found_at: new Date(Date.now() + 3600000).toISOString() },
        },
      }),
    );
    window.dispatchEvent(new Event("focus"));
  });
  await expect
    .poll(() => page.locator('[data-field="company"]').first().textContent())
    .toBe("Notion");
  await expect(company).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator('[data-field="company"]').filter({ hasText: "Linear" }),
  ).toHaveAttribute("aria-selected", "false");
});
test("active edit and conflict draft survive parent refresh and keyboard navigation", async ({
  page,
}) => {
  await page.goto("/bids");
  await page.getByLabel("Found period", { exact: true }).selectOption("all");
  const cell = page
    .locator('[data-field="company"]')
    .filter({ hasText: "Linear" });
  await cell.dblclick();
  const editor = page.getByRole("textbox", {
    name: "Edit company",
    exact: true,
  });
  await editor.fill("My draft");
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("fixture-change-bid", {
        detail: {
          id: "bid-0",
          patch: { version: 4, company: "Changed remotely" },
        },
      }),
    );
    window.dispatchEvent(new Event("focus"));
  });
  await expect(editor).toHaveValue("My draft");
  await editor.press("Enter");
  await expect(
    page.getByText(
      "Changed by another action. Review the latest value before retrying.",
    ),
  ).toBeVisible();
  await expect(editor).toHaveValue("My draft");
  await page
    .getByRole("button", { name: "Use latest version and keep draft" })
    .click();
  await editor.press("Tab");
  await expect(
    page.locator('[data-field="company"]').filter({ hasText: "My draft" }),
  ).toBeVisible();
  await expect(page.locator('[data-field="role_name"]').first()).toBeFocused();
});
test("auth validation identifies missing email and password to assistive technology", async ({
  page,
}) => {
  await page.goto("/auth/login");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page.getByText("Email is required.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Email address", { exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "aria-describedby",
    "password-error",
  );
});
test("exact seeded bids avoid mount read; changed query and local page size fetch normally", async ({
  page,
}) => {
  await page.goto("/bids?bid-seed");
  await expect(
    page.locator('[data-field="company"]').filter({ hasText: "Linear" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.dataset.bidListReads),
    )
    .toBe("0");
  await page.getByLabel("Found period", { exact: true }).selectOption("all");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number(document.documentElement.dataset.bidListReads),
      ),
    )
    .toBeGreaterThan(0);
  await page.getByLabel("Rows per page", { exact: true }).selectOption("25");
  await page.reload();
  await expect(page.getByLabel("Rows per page", { exact: true })).toHaveValue(
    "25",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number(document.documentElement.dataset.bidListReads),
      ),
    )
    .toBe(1);
});
test("matching error and pending-review seeds do not refetch during hydration", async ({
  page,
}) => {
  await page.goto("/bids?bid-seed&seed-error");
  await expect(page.getByRole("alert")).toContainText(
    "Seed results unavailable",
  );
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.dataset.bidListReads),
    )
    .toBe("0");
  await page.goto("/bids?bid-seed&review=pending");
  await expect(page.getByLabel("Found period", { exact: true })).toHaveValue(
    "all",
  );
  await expect(
    page.getByRole("button", { name: /Pending review/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-field="company"]')).toHaveCount(4);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.dataset.bidListReads),
    )
    .toBe("0");
});
test.describe("touch grid selection", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("touch selects one cell and tabular paste returns focus without changing the existing bid", async ({
    page,
  }) => {
    await page.goto("/bids");
    const cell = page
      .locator('[data-field="company"]')
      .filter({ hasText: "Linear" });
    await cell.tap();
    await expect(cell).toHaveAttribute("aria-selected", "true");
    await cell.evaluate((el) => {
      const data = new DataTransfer();
      data.setData(
        "text/plain",
        "New Company\tEngineer\thttps://preview.test/new",
      );
      el.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, clipboardData: data }),
      );
    });
    await expect(page.getByLabel("Copied Google Sheets cells")).toHaveValue(
      "New Company\tEngineer\thttps://preview.test/new",
    );
    await page.keyboard.press("Escape");
    await expect(cell).toBeFocused();
    await expect(cell).toHaveText("Linear");
  });
});
test("decorative paths mount only on desktop without reduced motion and are removed on preference changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/auth/login");
  await expect(
    page.locator('linearGradient[id^="linearGradient-"]'),
  ).toHaveCount(50);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.locator('linearGradient[id^="linearGradient-"]'),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.locator('linearGradient[id^="linearGradient-"]'),
  ).toHaveCount(50);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(
    page.locator('linearGradient[id^="linearGradient-"]'),
  ).toHaveCount(0);
});
