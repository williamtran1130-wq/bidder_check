import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";

const preview = process.env.SCREENSHOT_SIZE_PREVIEW_URL ?? "http://127.0.0.1:3001";
const badge = (page: Page, bytes: string, count: number) => page.getByRole("button", {
  name: `Screenshot size: ${bytes} bytes; ${count} screenshot${count === 1 ? "" : "s"} with this exact size in current results`, exact: true,
});
const row = (page: Page, company: string) => page.getByRole("row").filter({ has: page.getByRole("gridcell", { name: company, exact: true }) });
async function open(page: Page, parameters = "", path = "/bids") {
  await page.route("https://images.example.test/proof.png", (route) => route.fulfill({
    contentType: "image/png",
    body: readFileSync(new URL("../tests/fixtures/screenshot-size-proof.png", import.meta.url)),
  }));
  await page.goto(`${preview}${path}?screenshot-sizes&${parameters}`);
  await page.getByLabel("Found period").selectOption("all");
}
async function sortSize(page: Page, order: "smallest" | "largest") {
  await page.getByRole("button", { name: "Filter Screenshot", exact: true }).click();
  const control = page.getByRole("button", { name: `Size: ${order} first`, exact: true });
  await control.click();
  await page.getByRole("button", { name: "Filter Screenshot", exact: true }).click();
  await expect(control).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("columnheader").filter({ has: page.getByRole("button", { name: "Filter Screenshot", exact: true }) })).toHaveAttribute("aria-sort", order === "smallest" ? "ascending" : "descending");
}

test("off-page exact matches use stable colors; same rounded KB stays unique; keyboard and touch open details", async ({ page }, info) => {
  await open(page);
  const repeated = badge(page, "102,400", 2);
  await expect(repeated).toHaveText("100 KB · 2");
  const color = await repeated.getAttribute("class");
  await expect(badge(page, "102,401", 1)).toHaveText("100 KB");
  expect(await badge(page, "102,401", 1).getAttribute("class")).not.toBe(color);
  await expect(row(page, "Figma").getByText("Size unavailable")).toHaveCount(0);
  await expect(row(page, "Stripe").getByText("Size unavailable")).toBeVisible();
  await repeated.scrollIntoViewIfNeeded();
  if (info.project.name === "mobile") await repeated.tap();
  else { await repeated.focus(); await page.keyboard.press("Enter"); }
  await expect(page.getByText("102,400 bytes", { exact: true })).toBeVisible();
  await expect(page.getByText("2 screenshots with this exact size in current results (including this screenshot).", { exact: true })).toBeVisible();
  await expect(page.getByText(/does not prove identical image content/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(repeated).toBeFocused();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(badge(page, "102,400", 2)).toHaveAttribute("class", color!);
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await sortSize(page, "smallest");
  await expect(badge(page, "102,400", 2).first()).toHaveAttribute("class", color!);
  const companies = await page.locator('[data-field="company"]').allTextContents();
  expect(companies).toEqual(["GitHub", "Vercel", "Loom", "Linear", "Supabase", "Notion", "Ramp", "Retool", "Webflow", "Framer"]);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator('[data-field="company"]')).toHaveText(["Figma", "Stripe"]);
  await sortSize(page, "largest");
  await expect(page.locator('[data-field="company"]')).toHaveText(["Framer", "Webflow", "Retool", "Ramp", "Notion", "Linear", "Supabase", "Loom", "Vercel", "GitHub"]);
  await page.getByRole("textbox", { name: "Search bids" }).fill("Linear");
  await expect(badge(page, "102,400", 1)).toBeVisible();
});

test("size badges are visible to admins and embedded managers and hidden from bidder data", async ({ page }) => {
  await open(page, "role=admin");
  await expect(badge(page, "102,400", 2)).toBeVisible();
  await open(page, "", "/scoped-admin");
  await expect(badge(page, "102,400", 2)).toHaveCount(2);
  await open(page, "role=bidder&leak-size-metadata");
  await expect(page.getByRole("button", { name: /^Screenshot size:/ })).toHaveCount(0);
  await expect(page.getByText("Size unavailable")).toHaveCount(0);
  await page.getByRole("button", { name: "Filter Screenshot", exact: true }).click();
  await expect(page.getByRole("button", { name: "Size: smallest first" })).toHaveCount(0);
  await expect(page.getByLabel("Screenshot filter")).toBeVisible();
});

test("editing reloads the filtered snapshot and screenshot replacement refreshes other group members", async ({ page }) => {
  await open(page);
  await page.getByRole("textbox", { name: "Search bids" }).fill("Linear");
  await expect(badge(page, "102,400", 1)).toBeVisible();
  await row(page, "Linear").locator('[data-field="company"]').dblclick();
  await expect(page.getByRole("button", { name: "Filter Screenshot", exact: true })).toBeDisabled();
  await page.getByLabel("Edit company").fill("Changed company");
  await page.getByLabel("Edit company").press("Enter");
  await expect(page.locator('[data-field="company"]')).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search bids" }).fill("");
  await expect(badge(page, "102,400", 2)).toBeVisible();
  await page.route("https://upload.example.test/**", (route) => route.fulfill({ status: 200, body: "{}", headers: { "Access-Control-Allow-Origin": "*" } }));
  await row(page, "Changed company").getByRole("button", { name: "Replace screenshot" }).click();
  await row(page, "Changed company").getByLabel("Choose screenshot").setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: Buffer.alloc(8192, 1) });
  await expect(badge(page, "8,192", 1)).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(badge(page, "102,400", 1)).toBeVisible();
});

test("badges remain legible in light and dark and details fit narrow screens", async ({ page }, info) => {
  await open(page, "size-palette");
  const repeated = badge(page, "102,400", 2).first();
  await repeated.scrollIntoViewIfNeeded();
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", { name: "Toggle color theme" }).click();
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    const ratios = await page.getByRole("button", { name: /^Screenshot size:/ }).evaluateAll((buttons) => {
      const luminance = (color: string) => {
        // Tailwind 4 uses OKLCH. Let the browser convert the actual computed
        // color into sRGB instead of treating OKLCH coordinates as RGB.
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      return buttons.map((button) => {
        const style = getComputedStyle(button);
        const a = luminance(style.color), b = luminance(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    });
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
    await repeated.click();
    await expect(page.getByLabel("Screenshot file size details")).toBeVisible();
    const bounds = await page.getByLabel("Screenshot file size details").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    const scan = await new AxeBuilder({ page }).include('[aria-label="Screenshot file size details"]').withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(scan.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
    await page.screenshot({ path: `.superpowers/sdd/2026-10-12-screenshot-size-matching/evidence/sizes-${info.project.name}-${theme}.png`, fullPage: true });
    await page.getByRole("button", { name: "Close size details", exact: true }).click();
  }
});

test("active edits defer group refresh and conflict cancellation loads the current snapshot", async ({ page }) => {
  await open(page);
  await expect(badge(page, "102,400", 2)).toBeVisible();
  await row(page, "Linear").locator('[data-field="company"]').dblclick();
  const reads = await page.locator("html").getAttribute("data-bid-list-reads");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("fixture-screenshot-change", { detail: { id: "bid-0", bytes: 8192 } }));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(badge(page, "102,400", 2)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-bid-list-reads", reads!);
  await page.getByLabel("Edit company").fill("Draft company");
  await page.getByLabel("Edit company").press("Enter");
  await expect(page.getByRole("alert")).toContainText("Changed by another action");
  await expect(page.getByLabel("Edit company")).toHaveValue("Draft company");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(badge(page, "8,192", 1)).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(badge(page, "102,400", 1)).toBeVisible();
});

test("trash and restore recalculate matching counts and presence filtering and sorting remain available", async ({ page }) => {
  await open(page);
  await expect(badge(page, "102,400", 2)).toBeVisible();
  await row(page, "Linear").getByRole("button", { name: "Move to trash", exact: true }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(badge(page, "102,400", 1)).toBeVisible();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await expect(badge(page, "102,400", 1)).toBeVisible();
  await row(page, "Linear").getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("button", { name: "Back to active bids", exact: true }).click();
  await expect(badge(page, "102,400", 2)).toBeVisible();
  await page.getByRole("button", { name: "Filter Screenshot", exact: true }).click();
  await page.getByLabel("Screenshot filter").selectOption("No screenshot");
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-field="company"]')).toHaveText(["Figma"]);
  await expect(page.getByRole("button", { name: /^Screenshot size:/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Filter Screenshot", exact: true }).click();
  await page.getByLabel("Screenshot filter").selectOption("");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Screenshot", exact: true }).click();
  await expect(page.locator('[data-field="company"]').first()).toHaveText("Linear");
  await page.getByRole("button", { name: "Screenshot", exact: true }).click();
  await expect(page.locator('[data-field="company"]').first()).toHaveText("Figma");
});

test("pasted screenshot changes badges only after verification and releases the edit lock", async ({ page }) => {
  await open(page);
  await expect(badge(page, "102,400", 2)).toBeVisible();
  let releaseUpload: (() => void) | undefined;
  const uploadFinished = new Promise<void>((resolve) => { releaseUpload = resolve; });
  await page.route("https://upload.example.test/**", async (route) => {
    await uploadFinished;
    await route.fulfill({ status: 200, body: "{}", headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await row(page, "Linear").getByLabel(/^Screenshot paste target/).evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(4096)], "pasted.png", { type: "image/png" }));
    (target as HTMLElement).focus();
    target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  });
  await expect(page.getByRole("button", { name: "Filter Screenshot", exact: true })).toBeDisabled();
  await expect(badge(page, "102,400", 2)).toBeVisible();
  releaseUpload!();
  await expect(badge(page, "4,096", 2)).toHaveCount(1);
  await expect(row(page, "Linear").getByRole("button", { name: /Screenshot size: 4,096/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter Screenshot", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(badge(page, "102,400", 1)).toBeVisible();
});
