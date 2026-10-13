import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const base = "http://127.0.0.1:3001";
test("changing account removes size state and cached matches", async ({ page }) => {
  await page.goto(`${base}/switch-account?screenshot-sizes`);
  await page.getByLabel("Found period").selectOption("all");
  await page.getByRole("button", { name: "Filter Screenshot", exact: true }).click();
  await page.getByRole("button", { name: "Size: largest first", exact: true }).click();
  await page.getByRole("button", { name: "Filter Screenshot", exact: true }).click();
  await page.getByLabel("Screenshot filter").selectOption("Repeated sizes only");
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-field="company"]')).toHaveCount(2);
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-change-account")));
  await expect(page.getByRole("button", { name: /^Screenshot size:/ })).toHaveCount(0);
  await expect(page.getByText("Size unavailable")).toHaveCount(0);
  await page.getByRole("button", { name: "Filter Screenshot", exact: true }).click();
  await expect(page.getByLabel("Screenshot filter")).toHaveValue("");
  await expect(page.getByRole("button", { name: /^Size:/ })).toHaveCount(0);
});
test("repeated sizes filters globally, preserves sorting, resets pagination and clears", async ({ page }) => {
  await page.goto(`${base}/bids?screenshot-sizes`);
  await page.getByLabel("Found period").selectOption("all");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("button", { name: "Filter Screenshot", exact: true }).click();
  await page.getByRole("button", { name: "Size: largest first", exact: true }).click();
  await page.getByRole("button", { name: "Filter Screenshot", exact: true }).click();
  await page.getByLabel("Screenshot filter").selectOption("Repeated sizes only");
  await expect(page.getByRole("button", { name: "Size: largest first", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-field="company"]')).toHaveText(["Linear", "Supabase"]);
  await expect(page.getByRole("button", { name: /^Screenshot size: 102,400 bytes; 2/ })).toHaveCount(2);
  await page.getByRole("textbox", { name: "Search bids" }).fill("Linear");
  await expect(page.getByText("No applications with matching screenshot sizes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Filter Screenshot", exact: true }).click();
  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-field="company"]')).toHaveText(["Linear"]);
});

test("split status matches disappear in the applied cohort and bidder has no repeated option", async ({ page }) => {
  await page.goto(`${base}/bids?screenshot-sizes&split-sizes`);
  await page.getByLabel("Found period").selectOption("all");
  await page.getByRole("button", { name: "Filter Screenshot", exact: true }).click();
  await page.getByLabel("Screenshot filter").selectOption("Repeated sizes only");
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-field="company"]')).toHaveCount(2);
  await page.getByRole("button", { name: /^applied\s*0$/i }).click();
  await expect(page.getByText("No applications with matching screenshot sizes", { exact: true })).toBeVisible();
  await page.goto(`${base}/bids?screenshot-sizes&role=bidder&leak-size-metadata`);
  await page.getByRole("button", { name: "Filter Screenshot", exact: true }).click();
  await expect(page.getByLabel("Screenshot filter").locator("option")).toHaveText(["All", "Has screenshot", "No screenshot"]);
  await expect(page.getByRole("button", { name: /^Size:/ })).toHaveCount(0);
  await expect(page.getByText("Size unavailable")).toHaveCount(0);
});

test("resume search covers over 1000 assignments with grouped labels and compatible bidder scope", async ({ page }, info) => {
  await page.goto(`${base}/bids?shared-resumes`);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const selector = page.getByLabel("Resume", { exact: true });
  await selector.click();
  await expect(page.getByRole("listbox", { name: "Resume assignments" }).getByRole("option")).toHaveCount(51);
  await page.getByRole("button", { name: "Show 50 more", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Resume assignments" }).getByRole("option")).toHaveCount(101);
  await expect(page.getByRole("combobox", { name: "Search resume assignments" })).toBeFocused();
  await page.getByRole("combobox", { name: "Search resume assignments" }).fill("assignment1099");
  await expect(page.getByRole("option", { name: /ENG-01 · Jordan Lee — Jamie Parker · assignment1099@example.test · Archived/ })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(selector).toContainText("assignment1099@example.test · Archived");
  await selector.click();
  await expect(page.getByRole("option", { name: /assignment1099@example.test · Archived/ })).toHaveAttribute("aria-selected", "true");
  const renderedOptions = page.getByRole("listbox", { name: "Resume assignments" }).getByRole("option");
  const selectedIndex = await renderedOptions.evaluateAll((elements) => elements.findIndex((element) => element.getAttribute("aria-selected") === "true"));
  const nextId = await renderedOptions.nth(selectedIndex + 1).getAttribute("id");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("combobox", { name: "Search resume assignments" })).toHaveAttribute("aria-activedescendant", nextId!);
  await page.keyboard.press("Escape");
  await page.getByLabel("Bidder", { exact: true }).selectOption("bidder-0");
  await expect(selector).toContainText("assignment1099@example.test");
  await page.getByLabel("Bidder", { exact: true }).selectOption("bidder-1");
  await expect(selector).toHaveText("All resumes");
  await selector.click();
  await expect(page.getByRole("listbox", { name: "Resume assignments" }).getByRole("option")).toHaveCount(2);
  await expect(page.getByRole("option", { name: /Jordan Lee — Taylor Reed · bidder1@example.test/ })).toBeVisible();
  expect((await new AxeBuilder({ page }).include('[role="listbox"]').analyze()).violations).toEqual([]);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value === "dark"), theme);
    await page.screenshot({ path: `.superpowers/sdd/2026-10-12-reliable-notifications-private-review/visuals/resumes-${info.project.name}-${theme}.png`, fullPage: true });
  }
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add bid", exact: true }).click();
  await expect(page.getByLabel("Resume profile").locator("option")).toHaveCount(1);
  await expect(page.getByLabel("Resume profile").locator("option")).toContainText("Taylor Reed · bidder1@example.test");
});
