import { expect, test, type Locator } from "@playwright/test";

const fixture = "http://127.0.0.1:3001";
test.use({ viewport: { width: 320, height: 900 } });

async function expectSelectedLabelFits(select: Locator) {
  const geometry = await select.evaluate((element: HTMLSelectElement) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const label = element.selectedOptions[0].text;
    // Native select arrows occupy trailing space beyond the declared padding.
    const required =
      context.measureText(label).width +
      parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight) +
      16;
    return { available: element.clientWidth, required, label };
  });
  expect(
    geometry.available,
    `Selected label ${geometry.label} has room for text and native arrow`,
  ).toBeGreaterThanOrEqual(geometry.required);
}

for (const theme of ["light", "dark"] as const) {
  test(`320px ${theme} footer keeps page size readable and pagination/editing functional`, async ({
    page,
  }, testInfo) => {
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === fixture
        ? route.continue()
        : route.abort(),
    );
    await page.routeWebSocket("**/*", (socket) => socket.close());
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(
      (value) => localStorage.setItem("theme", value),
      theme,
    );
    await page.goto(`${fixture}/bids`);
    await page.getByLabel("Found period", { exact: true }).selectOption("all");
    const select = page.getByRole("combobox", {
      name: "Rows per page",
      exact: true,
    });
    await expect(select).toHaveValue("10");
    await select.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("footer-initial.png"),
      fullPage: true,
    });
    await expectSelectedLabelFits(select);
    const next = page.getByRole("button", { name: "Next page", exact: true });
    const previous = page.getByRole("button", {
      name: "Previous page",
      exact: true,
    });
    const footer = select.locator("xpath=../../..");
    await select.selectOption("custom");
    await expectSelectedLabelFits(select);
    const custom = page.getByRole("spinbutton", {
      name: "Custom rows per page",
      exact: true,
    });
    await expect(custom).toBeVisible();
    for (const control of [select, custom, previous, next]) {
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    }
    await custom.fill("1");
    await expect(footer).toContainText(/1\u20131 of/);
    await expect(next).toBeEnabled();
    await next.click();
    await expect(footer).toContainText(/2\u20132 of/);
    await previous.click();
    await expect(footer).toContainText(/1\u20131 of/);
    await custom.fill("100");
    await expect(custom).toHaveValue("100");
    await expect(next).toBeDisabled();
    await custom.fill("0");
    await expect(custom).toHaveValue("100");
    await custom.fill("101");
    await expect(custom).toHaveValue("100");
    await page.locator('[data-grid-r="0"][data-field="company"]').dblclick();
    const editor = page.getByRole("textbox", {
      name: "Edit company",
      exact: true,
    });
    await expect(editor).toBeVisible();
    for (const control of [select, custom, previous, next])
      await expect(control).toBeDisabled();
    await editor.press("Escape");
    await expect(select).toBeEnabled();
    await expect(custom).toBeEnabled();
    await select.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("footer-custom.png"),
      fullPage: true,
    });
  });
}
