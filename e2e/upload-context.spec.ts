import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";

const preview = "http://127.0.0.1:3001";
async function open(page: Page, flags = "") {
  await page.route("https://images.example.test/proof.png", (route) => route.fulfill({ contentType: "image/png", body: readFileSync(new URL("../tests/fixtures/screenshot-size-proof.png", import.meta.url)) }));
  await page.goto(`${preview}/bids?screenshot-sizes&upload-context&${flags}`);
  await page.getByLabel("Found period").selectOption("all");
}
async function previewScreenshot(page: Page, mobile: boolean) {
  await page.getByLabel(/^Screenshot paste target for Linear\./).scrollIntoViewIfNeeded();
  const trigger = page.getByRole("button", { name: "Preview screenshot for Linear", exact: true });
  await trigger.scrollIntoViewIfNeeded();
  if (mobile) await trigger.tap(); else { await trigger.focus(); await page.keyboard.press("Enter"); }
  return trigger;
}
test("loads private upload details only on preview, with keyboard/mobile access and copyable IP", async ({ page }, info) => {
  await open(page);
  expect(await page.locator("html").getAttribute("data-upload-context-reads") ?? "0").toBe("0");
  expect(await page.locator("html").getAttribute("data-upload-history-reads") ?? "0").toBe("0");
  const trigger = await previewScreenshot(page, info.project.name === "mobile");
  const details = page.getByRole("region", { name: "Upload details", exact: true });
  await expect(details).toContainText("Jordan Upload (bidder)");
  await expect(details).toContainText("Chicago, IL, US");
  await expect(details).toContainText("Approximate IP location");
  await expect(page.locator("html")).toHaveAttribute("data-upload-context-reads", "1");
  const copy = details.getByRole("button", { name: "Copy IP address" });
  await expect(copy).toBeVisible();
  if (info.project.name !== "mobile") {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await copy.focus(); await page.keyboard.press("Enter");
    await expect(details.getByRole("status")).toContainText("IP address copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("203.0.113.10");
  }
  const bounds = await details.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  const scan = await new AxeBuilder({ page }).include('[aria-label="Upload details"]').withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(scan.violations.filter((issue) => ["serious", "critical"].includes(issue.impact ?? ""))).toEqual([]);
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
});
test("distinguishes historical not-recorded, new unavailable metadata, and retryable load failure", async ({ page }, info) => {
  await open(page, "upload-context-old"); await previewScreenshot(page, info.project.name === "mobile");
  await expect(page.getByRole("region", { name: "Upload details", exact: true })).toContainText("Not recorded");
  await open(page, "upload-context-unavailable"); await previewScreenshot(page, info.project.name === "mobile");
  const unavailable = page.getByRole("region", { name: "Upload details", exact: true });
  await expect(unavailable).toContainText("Unavailable"); await expect(unavailable.getByRole("button", { name: "Copy IP address" })).toHaveCount(0);
  await open(page, "upload-context-recover"); await previewScreenshot(page, info.project.name === "mobile");
  await expect(page.getByRole("alert")).toContainText("could not be loaded");
  await page.getByRole("button", { name: "Retry upload details" }).click();
  await expect(page.getByRole("region", { name: "Upload details", exact: true })).toContainText("Chicago, IL, US");
});
test("keeps screenshot fields free of the collection notice and private data out of bidder previews", async ({ page }, info) => {
  await open(page, "role=bidder");
  const notice = page.getByText("Screenshot uploads record your IP address and approximate IP location for client/admin review. VPNs and proxies may affect the location.", { exact: true });
  await expect(notice).toHaveCount(0);
  const screenshot = page.getByLabel(/^Screenshot paste target for Linear\./);
  await screenshot.getByRole("button", { name: "Replace screenshot", exact: true }).click();
  await expect(screenshot.getByLabel("Upload or paste an application screenshot", { exact: true })).toBeVisible();
  await expect(notice).toHaveCount(0);
  await previewScreenshot(page, info.project.name === "mobile");
  await expect(page.getByRole("region", { name: "Upload details", exact: true })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-upload-context-reads", "0");
  await expect(page.locator("html")).toHaveAttribute("data-upload-history-reads", "0");
});
test("lazy manager history preserves unavailable screenshots, manager attribution and cursor pages", async ({ page }, info) => {
  await open(page, "upload-context-pages");
  const row = page.getByRole("row").filter({ has: page.getByRole("gridcell", { name: "Linear", exact: true }) });
  const trigger = row.getByRole("button", { name: /^View .+ at Linear$/ });
  await trigger.scrollIntoViewIfNeeded();
  if (info.project.name === "mobile") await trigger.tap(); else { await trigger.focus(); await page.keyboard.press("Enter"); }
  const history = page.getByRole("region", { name: "Upload history", exact: true });
  await expect(history).toContainText("Screenshot unavailable");
  await expect(history).toContainText("Casey Manager (client)");
  await expect(history).toContainText("São Paulo, SP, BR");
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await expect(page.locator("html")).toHaveAttribute("data-upload-history-reads", "1");
  await history.getByRole("button", { name: "Load more uploads", exact: true }).click();
  await expect(history.getByRole("listitem")).toHaveCount(3);
  await expect(page.locator("html")).toHaveAttribute("data-upload-history-reads", "2");
  await expect(history.getByRole("button", { name: "Load more uploads", exact: true })).toHaveCount(0);
  const overflow = await history.evaluate((region) => region.scrollWidth > region.clientWidth);
  expect(overflow).toBe(false);
});
