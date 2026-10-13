import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ baseURL: "http://127.0.0.1:3001" });

async function releaseRead(page: Page, error = false) {
  await page.evaluate((fail) => {
    document.documentElement.dataset.pageLoadingReleased = "true";
    document.documentElement.dataset.pageLoadingError = String(fail);
    window.dispatchEvent(new Event("fixture-release-page"));
  }, error);
}

test("workspace loading is visible, centered, and quiet with reduced motion", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/loading-workspace");
  const status = page.getByRole("status").filter({ hasText: "Loading workspace" });
  await expect(status).toBeVisible();
  const track = status.locator(".page-loading-track");
  await expect(track).toBeVisible();
  await expect(status).not.toHaveAttribute("aria-valuenow");
  await expect(track).toHaveAttribute("aria-hidden", "true");
  const bar = track.locator("span");
  await expect(bar).toHaveCSS("animation-name", "none");
  expect((await new AxeBuilder({ page }).include(".page-loading").analyze()).violations).toEqual([]);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const frame = await status.boundingBox();
    const bounds = await track.boundingBox();
    expect(frame).not.toBeNull();
    expect(bounds).not.toBeNull();
    expect(Math.abs(bounds!.x + bounds!.width / 2 - (frame!.x + frame!.width / 2))).toBeLessThan(2);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`workspace-loading-${width}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(track).toBeVisible();
  expect((await new AxeBuilder({ page }).include(".page-loading").analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("workspace-loading-dark.png") });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(bar).toHaveCSS("animation-name", "page-loading-slide");
});

for (const route of ["bids", "earnings", "interviews"]) {
  test(`${route} shows a centered loading bar until the read completes`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${route}?page-loading`);
    const status = page.getByRole("status").filter({ has: page.locator(".page-loading-track") });
    await expect(status).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-page-loading-reads", "1");
    const track = status.locator(".page-loading-track");
    await status.scrollIntoViewIfNeeded();
    const bounds = (await track.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(Math.abs(bounds.x + bounds.width / 2 - 195)).toBeLessThan(5);
    if (route === "bids") {
      await page.getByRole("region", { name: "Bid table, scroll horizontally for all columns" }).evaluate((element) => { element.scrollLeft = 300; });
      const scrolled = (await track.boundingBox())!;
      expect(Math.abs(scrolled.x - bounds.x)).toBeLessThan(2);
    }
    await page.screenshot({ path: testInfo.outputPath(`${route}-loading-mobile.png`) });
    await releaseRead(page);
    await expect(status).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-page-loading-reads", "1");
    if (route === "bids") await expect(page.getByRole("checkbox", { name: /^Select bid at/ })).toHaveCount(1);
    else if (route === "earnings") await expect(page.getByRole("table")).toContainText("$10.00");
    else await expect(page.getByRole("table")).toContainText("ENG-01");
  });
}

test("a failed read replaces the loading bar with the existing error and Retry recovers", async ({ page }) => {
  await page.goto("/earnings?page-loading");
  const status = page.getByRole("status").filter({ hasText: "Loading earnings" });
  await expect(status).toBeVisible();
  await releaseRead(page, true);
  await expect(status).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Fixture report unavailable");
  await releaseRead(page);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("$10.00");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-page-loading-reads", "2");
});
