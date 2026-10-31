import { test, expect } from "@playwright/test";

const preview = process.env.PREVIEW_URL ?? "http://127.0.0.1:3001";
const longName = "Workspace - Alexandra Catherine Montgomery Rivera and the International Candidate Operations Team";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/mail-insights/status*", route => route.fulfill({ json: { status: "not_synced", updatedAt: null, from: null, to: null } }));
  await page.clock.setFixedTime(new Date("2026-10-12T17:00:00Z"));
});

test("paired arrangement bars reconcile with every exact count and completion", async ({ page }) => {
  await page.goto(`${preview}/dashboard?arrangements=mixed`);
  const comparison = page.getByRole("region", { name: "By profile", exact: true });
  await expect(comparison.getByRole("img", { name: "ENG-01 Found: 10 total; Remote 5; Onsite/hybrid 3; Unspecified 2." })).toBeVisible();
  await expect(comparison.getByRole("img", { name: "ENG-01 Applied: 6 total; Remote 3; Onsite/hybrid 2; Unspecified 1." })).toBeVisible();
  const foundSegments = await comparison.getByRole("img", { name: /^ENG-01 Found:/ }).locator("span[style]").evaluateAll((segments) => segments.map((segment) => segment.getBoundingClientRect().width));
  const appliedSegments = await comparison.getByRole("img", { name: /^ENG-01 Applied:/ }).locator("span[style]").evaluateAll((segments) => segments.map((segment) => segment.getBoundingClientRect().width));
  expect(foundSegments[0] / foundSegments[1]).toBeCloseTo(5 / 3, 1);
  expect(foundSegments[0] / foundSegments[2]).toBeCloseTo(5 / 2, 1);
  expect(appliedSegments.reduce((sum, width) => sum + width, 0) / foundSegments.reduce((sum, width) => sum + width, 0)).toBeCloseTo(0.6, 1);
  await comparison.getByText("View all comparison values", { exact: true }).click();
  const table = comparison.getByRole("table", { name: "By profile values" });
  await expect(table.getByRole("row").nth(1).getByRole("cell")).toHaveText(["10", "6", "—", "—", "60.0%"]);
  await expect(table.getByRole("row").nth(2).getByRole("cell")).toHaveText(["5", "3", "60.0%"]);
  await expect(table.getByRole("row").nth(3).getByRole("cell")).toHaveText(["3", "2", "66.7%"]);
  await expect(table.getByRole("row").nth(4).getByRole("cell")).toHaveText(["2", "1", "50.0%"]);
  await expect(comparison).toContainText("Older retained history may have no recorded arrangement.");
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(comparison.getByRole("img", { name: /ENG-01 Found: 10 total/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("missing breakdown preserves totals without inventing arrangement zeroes", async ({ page }) => {
  await page.goto(`${preview}/dashboard?arrangements=unavailable`);
  const comparison = page.getByRole("region", { name: "By profile", exact: true });
  await expect(comparison.getByRole("group", { name: /^By profile: found and applied/ }).getByText("Breakdown unavailable", { exact: true })).toBeVisible();
  await expect(comparison.getByRole("img", { name: /Remote/ })).toHaveCount(0);
  await comparison.getByText("View all comparison values", { exact: true }).click();
  const table = comparison.getByRole("table", { name: "By profile values" });
  await expect(table.getByRole("row").nth(1).getByRole("cell")).toHaveText(["10", "6", "—", "—", "60.0%"]);
  await expect(table).toContainText("Breakdown unavailable");
  await expect(table.getByRole("row")).toHaveCount(2);
});

test("unclassified history is unspecified while an empty cohort stays empty", async ({ page }) => {
  await page.goto(`${preview}/dashboard?arrangements=unknown&role=bidder`);
  await expect(page.getByRole("region", { name: "By bidder", exact: true })).toHaveCount(0);
  const comparison = page.getByRole("region", { name: "By profile", exact: true });
  await expect(comparison.getByRole("img", { name: "ENG-01 Found: 10 total; Remote 0; Onsite/hybrid 0; Unspecified 10." })).toBeVisible();
  await expect(page.getByText(/Earned|\$\d/)).toHaveCount(0);
  await page.goto(`${preview}/dashboard?arrangements=empty`);
  await expect(page.getByText("No bids found in this period.", { exact: true })).toHaveCount(2);
  await expect(page.getByText("View all comparison values", { exact: true })).toHaveCount(0);
});

test("top ten ordering keeps applied then found then ID ranking and all exact rows", async ({ page }) => {
  await page.goto(`${preview}/dashboard?arrangements=ten`);
  const comparison = page.getByRole("region", { name: "By profile", exact: true });
  await expect(comparison.getByText("Top 10 of 12", { exact: true })).toBeVisible();
  const bars = comparison.getByRole("img", { name: / Found:/ });
  await expect(bars).toHaveCount(10);
  await expect(bars.nth(0)).toHaveAccessibleName(/^A full candidate profile name/);
  await expect(bars.nth(1)).toHaveAccessibleName(/^Profile 01 Found:/);
  await expect(bars.nth(9)).toHaveAccessibleName(/^Profile 09 Found:/);
  await comparison.getByText("View all comparison values", { exact: true }).click();
  const table = comparison.getByRole("table", { name: "By profile values" });
  await expect(table).toContainText("Profile 11");
  await expect(table.getByRole("row")).toHaveCount(49);
  const bidder = await page.getByRole("region", { name: "By bidder", exact: true }).boundingBox();
  const profile = await comparison.boundingBox();
  expect(bidder).not.toBeNull(); expect(profile).not.toBeNull();
  if (page.viewportSize()!.width >= 1280) expect(Math.abs(bidder!.y - profile!.y)).toBeLessThan(2);
  else expect(profile!.y).toBeGreaterThan(bidder!.y + bidder!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("short navigation labels preserve routes and full workspace names stay accessible", async ({ page }) => {
  await page.goto(`${preview}/dashboard?long-workspace`);
  if (page.viewportSize()!.width < 1024) await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("navigation");
  for (const [label, href] of [["Bids", "/bids"], ["Resumes", "/resumes"], ["Profiles", "/profiles"], ["Interviews", "/interviews"]]) {
    await expect(navigation.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", href);
  }
  const workspace = page.getByText(longName, { exact: true }).filter({ visible: true });
  await expect(workspace).toBeVisible();
  await expect(page.getByText("AC", { exact: true }).filter({ visible: true })).toBeVisible();
  const box = await workspace.boundingBox();
  expect(box!.height).toBeGreaterThan(30);
  if (page.viewportSize()!.width >= 1024) {
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    const trigger = page.getByRole("button", { name: longName, exact: true });
    await trigger.focus();
    await expect(page.getByRole("tooltip")).toContainText(longName);
    await trigger.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
  await page.goto(`${preview}/bids?no-workspace`);
  if (page.viewportSize()!.width < 1024) await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByText("Workspace", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("My workspace", { exact: true })).toHaveCount(0);
});

test("long workspace names keep bottom navigation reachable in short windows", async ({ page }) => {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 600 });
  await page.goto(`${preview}/dashboard?long-workspace`);
  const mobile = page.viewportSize()!.width < 1024;
  if (mobile) await page.getByRole("button", { name: "Open navigation" }).click();
  const sidebar = page.getByRole(mobile ? "dialog" : "complementary");
  const signOut = sidebar.getByRole("button", { name: "Sign out", exact: true });
  await signOut.scrollIntoViewIfNeeded();
  await expect(signOut).toBeInViewport();
});
