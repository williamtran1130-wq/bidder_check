import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";

const fixture = "http://127.0.0.1:3001";
test.use({ baseURL: fixture });

async function open(page: Page, route = "/bids", flags = "") {
  await page.route("**/*", (request) => {
    const url = request.request().url();
    if (new URL(url).origin === fixture) return request.continue();
    if (url === "https://images.example.test/proof.png")
      return request.fulfill({
        contentType: "image/png",
        body: readFileSync(new URL("../tests/fixtures/screenshot-size-proof.png", import.meta.url)),
      });
    return request.abort();
  });
  await page.routeWebSocket("**/*", (socket) => socket.close());
  await page.goto(`${route}?screenshot-sizes&upload-context&${flags}`);
  await expect(page.getByRole("grid", { name: "Bid applications", exact: true })).toBeVisible();
}

function firstCell(page: Page) {
  return page.getByRole("row").filter({ has: page.getByRole("gridcell", { name: "Linear", exact: true }) })
    .locator('[data-field="applied_ip_location"]');
}

for (const [name, route, flags] of [
  ["client", "/bids", ""],
  ["admin", "/bids", "role=admin"],
  ["embedded admin", "/scoped-admin", ""],
]) {
  test(`${name} shows one combined IP/location field immediately after Screenshot without a reveal click`, async ({ page }, info) => {
    await open(page, route, flags);
    const headings = await page.getByRole("columnheader").allTextContents();
    const screenshot = headings.findIndex((text) => text.trim() === "Screenshot");
    expect(screenshot).toBeGreaterThan(0);
    expect(headings[screenshot + 1]).toBe("Applied IP / location");
    expect(headings.filter((text) => /IP|location/.test(text))).toEqual(["Applied IP / location"]);
    await expect(page.locator("html")).toHaveAttribute("data-upload-context-reads", "0");
    const cell = firstCell(page);
    await cell.scrollIntoViewIfNeeded();
    await expect(cell).toContainText("203.0.113.10");
    await expect(cell).toContainText("Chicago, IL, US");
    await expect(cell).toContainText("Approximate IP location");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-upload-context-batches", "1");
    await expect(page.getByRole("button", { name: /^(View|Hide) IP \/ location$/ })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${name.replaceAll(" ", "-")}-combined-column.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
  });
}

test("multiple visible cells share one metadata batch and keep their fields on a same-page rerender", async ({ page }) => {
  await open(page);
  await expect(firstCell(page)).toContainText("203.0.113.10");
  await expect(page.locator("html")).toHaveAttribute("data-upload-context-batches", "1");
  await page.getByLabel("Found period", { exact: true }).selectOption("all");
  const cells = page.locator('[data-field="applied_ip_location"]');
  await expect(cells).toHaveCount(10);
  await expect(cells.filter({ hasText: "203.0.113.10" })).toHaveCount(9);
  await expect(page.locator("html")).toHaveAttribute("data-upload-context-batches", "2");
  const ids = JSON.parse(await page.locator("html").getAttribute("data-upload-context-batch-ids") ?? "[]");
  expect(ids).toHaveLength(9);
  expect(new Set(ids).size).toBe(9);
  const row = page.getByRole("row").filter({ has: page.getByRole("gridcell", { name: "Linear", exact: true }) });
  const checkbox = row.getByRole("checkbox");
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();
  // Allow the 16 ms coalescing window after the committed rerender.
  await page.waitForTimeout(50);
  await expect(cells.filter({ hasText: "203.0.113.10" })).toHaveCount(9);
  await expect(page.locator("html")).toHaveAttribute("data-upload-context-batches", "2");
  await expect(page.locator("html")).toHaveAttribute("data-upload-context-reads", "0");
});

test("bidder has neither the column nor private reads, including after account switch", async ({ page }) => {
  await open(page, "/bids", "role=bidder");
  await expect(page.getByRole("columnheader", { name: "Applied IP / location", exact: true })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-upload-context-reads", "0");
  await expect(page.locator("html")).toHaveAttribute("data-upload-context-batches", "0");
  await open(page, "/switch-account");
  await expect(firstCell(page)).toContainText("203.0.113.10");
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-change-account")));
  await expect(page.getByRole("columnheader", { name: "Applied IP / location", exact: true })).toHaveCount(0);
  await expect(page.getByText("203.0.113.10", { exact: true })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-upload-context-batches", "1");
  await expect(page.locator("html")).toHaveAttribute("data-upload-context-reads", "0");
});

test("historical, unavailable and absent screenshot states remain distinct", async ({ page }) => {
  await open(page, "/bids", "upload-context-old");
  await expect(firstCell(page)).toContainText("Not recorded");
  await expect(firstCell(page).getByRole("button", { name: "Copy IP address", exact: true })).toHaveCount(0);
  await open(page, "/bids", "upload-context-unavailable");
  await expect(firstCell(page).getByText("Unavailable", { exact: true })).toHaveCount(2);
  await expect(firstCell(page).getByRole("button", { name: "Copy IP address", exact: true })).toHaveCount(0);
  await page.getByLabel("Found period", { exact: true }).selectOption("all");
  const empty = page.locator('[data-field="applied_ip_location"]').filter({ hasText: "No screenshot" });
  await expect(empty).toHaveCount(1);
  await expect(empty.getByRole("button")).toHaveCount(0);
});

test("explicit retry recovers inside the cell and clipboard preserves exact IP", async ({ page }, info) => {
  await open(page, "/bids", "upload-context-recover");
  const cell = firstCell(page);
  await expect(cell.getByRole("alert")).toContainText("could not be loaded");
  await expect(page.locator("html")).toHaveAttribute("data-upload-context-batches", "1");
  await cell.getByRole("button", { name: "Retry IP / location", exact: true }).click();
  await expect(cell).toContainText("Chicago, IL, US");
  await expect(page.locator("html")).toHaveAttribute("data-upload-context-batches", "2");
  if (info.project.name !== "mobile") {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await cell.getByRole("button", { name: "Copy IP address", exact: true }).click();
    await expect(cell.getByRole("status")).toContainText("IP address copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("203.0.113.10");
  }
});

test("replacing evidence clears old metadata and automatically loads the new field", async ({ page }) => {
  await open(page);
  const cell = firstCell(page);
  await expect(cell).toContainText("203.0.113.10");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture-change-bid", {
    detail: { id: "bid-0", patch: { evidence_file_id: "replacement-screenshot", version: 1 } },
  })));
  await page.getByLabel("Rows per page", { exact: true }).selectOption("25");
  await expect(cell).not.toContainText("203.0.113.10");
  await expect(cell).toContainText("203.0.113.20");
  await expect(cell.getByRole("button", { name: "View IP / location", exact: true })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-upload-context-batches", "2");
});

for (const change of ["account", "same-role actor", "file"]) {
  test(`late metadata cannot reappear after ${change} changes`, async ({ page }) => {
    await open(page, "/switch-account", "upload-context-delay");
    await expect(firstCell(page).getByRole("status")).toContainText("Loading IP / location");
    if (change === "account") {
      await page.evaluate(() => window.dispatchEvent(new Event("fixture-change-account")));
      await expect(page.getByRole("columnheader", { name: "Applied IP / location", exact: true })).toHaveCount(0);
    } else if (change === "same-role actor") {
      await page.evaluate(() => window.dispatchEvent(new Event("fixture-change-manager")));
      await expect(firstCell(page)).toContainText("203.0.113.20");
    } else {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture-change-bid", {
        detail: { id: "bid-0", patch: { evidence_file_id: "replacement-screenshot", version: 1 } },
      })));
      await page.getByLabel("Rows per page", { exact: true }).selectOption("25");
      await expect(firstCell(page)).toContainText("203.0.113.20");
    }
    await page.evaluate(async () => {
      window.dispatchEvent(new Event("fixture-release-upload-context"));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    if (change === "file") {
      await expect(firstCell(page)).not.toContainText("203.0.113.10");
      await expect(firstCell(page)).toContainText("203.0.113.20");
    } else {
      await expect(page.getByText("203.0.113.10", { exact: true })).toHaveCount(0);
    }
    await expect(page.locator("html")).toHaveAttribute("data-upload-context-batches", change === "account" ? "1" : "2");
    await expect(page.locator("html")).toHaveAttribute("data-upload-context-reads", "0");
  });
}

test("long IPv6 and international location remain readable in one cell", async ({ page }, info) => {
  await open(page, "/bids", "upload-context-ipv6");
  const cell = firstCell(page);
  await cell.scrollIntoViewIfNeeded();
  await expect(cell).toContainText("2001:db8:ffff:ffff:ffff:ffff:ffff:ffff");
  await expect(cell).toContainText("São Paulo, SP, BR");
  expect(await cell.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
  const scan = await new AxeBuilder({ page }).include('[data-field="applied_ip_location"]').withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(scan.violations.filter((issue) => ["serious", "critical"].includes(issue.impact ?? ""))).toEqual([]);
  await page.screenshot({ path: info.outputPath("ipv6-combined-column.png"), fullPage: true });
});

test("clipboard-denied fallback selects and copies the IP instead of a prior grid selection", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: async () => { throw new DOMException("Denied", "NotAllowedError"); },
    });
  });
  await open(page);
  await page.getByRole("gridcell", { name: "Linear", exact: true }).click();
  const cell = firstCell(page);
  await expect(cell).toContainText("203.0.113.10");
  await cell.getByRole("button", { name: "Copy IP address", exact: true }).click();
  await expect(cell.getByRole("status")).toContainText("Select the IP address to copy it");
  const address = cell.getByText("203.0.113.10", { exact: true });
  const prevented = await address.evaluate((element) => {
    const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await cell.getByRole("button", { name: "Copy IP address", exact: true }).focus();
  await address.evaluate((element) => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press("Control+C");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("203.0.113.10");
});
