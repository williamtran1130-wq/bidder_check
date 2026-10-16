import { test, expect, type Page } from "@playwright/test";

const origin = process.env.EGRESS_PREVIEW_ORIGIN ?? "http://127.0.0.1:3001";
const imageBody = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="green"/></svg>';
async function setup(page: Page, count = 2) {
  await page.clock.install({ time: new Date("2026-10-16T12:00:00Z") });
  await page.addInitScript(() => {
    const Observer = window.IntersectionObserver;
    window.IntersectionObserver = class extends Observer {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super((entries, observer) => {
          for (const entry of entries) entry.target.setAttribute("data-fixture-intersecting", String(entry.isIntersecting));
          callback(entries, observer);
        }, options);
      }
    };
    let visibility = "visible";
    Object.defineProperty(document, "visibilityState", { get: () => visibility });
    Object.defineProperty(window, "setFixtureVisibility", { value: (next: string) => {
      visibility = next;
      document.dispatchEvent(new Event("visibilitychange"));
    } });
  });
  const images: string[] = [];
  let purgeReads = 0;
  await page.route("https://images.example.test/**", (route) => {
    images.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: "image/svg+xml", headers: { "cache-control": "no-store" }, body: imageBody });
  });
  await page.route("**/api/read/purges**", (route) => {
    purgeReads++;
    return route.fulfill({ contentType: "application/json", body: '{"data":[]}' });
  });
  await page.goto(`${origin}/egress.html?egress&screenshot-sizes&purge-read-transport&count=${count}`);
  return { images, purgeReads: () => purgeReads };
}
async function visible(page: Page, value: "visible" | "hidden") {
  await page.evaluate((state) => {
    (window as unknown as { setFixtureVisibility: (next: string) => void }).setFixtureVisibility(state);
  }, value);
}
const previews = (page: Page) => page.getByRole("button", { name: /Preview screenshot for/ });
const batches = async (page: Page) => Number(await page.locator("html").getAttribute("data-file-batch-reads"));

test("25 mounted screenshots download once over five minutes while authorization renews", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 1400 });
  const metrics = await setup(page, 25);
  await expect(previews(page)).toHaveCount(25);
  await expect.poll(() => metrics.images.length).toBe(25);
  for (let i = 0; i < 6; i++) {
    await page.clock.runFor(46_000);
    await expect.poll(() => batches(page)).toBe(i + 2);
  }
  await page.clock.runFor(24_000);
  await testInfo.attach("egress-counts.json", { contentType: "application/json", body: JSON.stringify({ source: "synthetic-fixture", simulatedSeconds: 300, imageRequests: metrics.images.length, imageBodyBytes: metrics.images.length * Buffer.byteLength(imageBody), signingBatches: await batches(page), purgeReads: metrics.purgeReads() }) });
  expect(metrics.images).toHaveLength(25);
});

test("hidden tabs suspend screenshot renewal and purge polling and resume once", async ({ page }) => {
  const metrics = await setup(page);
  await expect(previews(page)).toHaveCount(2);
  await expect.poll(() => metrics.purgeReads()).toBeGreaterThan(0);
  const initialPurges = metrics.purgeReads();
  const initial = await batches(page);
  await visible(page, "hidden");
  await page.clock.runFor(180_000);
  expect(await batches(page)).toBe(initial);
  expect(metrics.purgeReads()).toBe(initialPurges);
  await visible(page, "visible");
  await page.clock.runFor(100);
  await expect.poll(() => metrics.purgeReads()).toBe(initialPurges + 1);
  await expect.poll(() => batches(page)).toBe(initial + 1);
  await page.clock.runFor(1000);
  expect(metrics.purgeReads()).toBe(initialPurges + 1);
});

test("opening an expired-source preview uses fresh authorization without reloading the table", async ({ page }) => {
  const metrics = await setup(page);
  await expect(previews(page)).toHaveCount(2);
  await page.clock.runFor(70_000);
  const before = metrics.images.length;
  await previews(page).first().click();
  const enlarged = page.getByRole("img", { name: "Enlarged application proof for Evidence 1" });
  await expect(enlarged).toBeVisible();
  await expect(enlarged).toHaveAttribute("src", /token=2/);
  await expect.poll(() => metrics.images.length).toBe(before + 1);
  await page.clock.runFor(100_000);
  expect(metrics.images).toHaveLength(before + 1);
  await expect(enlarged).toHaveAttribute("src", /token=2/);
});

test("offscreen cells pause renewal and an open preview retains access checks", async ({ page }) => {
  await setup(page);
  await expect(previews(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Toggle offscreen", exact: true }).click();
  await expect(page.locator('[aria-label^="Screenshot paste target"]').first()).toHaveAttribute("data-fixture-intersecting", "false");
  await page.clock.runFor(100);
  const initial = await batches(page);
  await page.clock.runFor(70_000);
  expect(await batches(page)).toBe(initial);
  await page.getByRole("button", { name: "Toggle offscreen", exact: true }).click();
  await page.clock.runFor(100);
  await expect.poll(() => batches(page)).toBe(initial + 1);
});

test("failed renewal removes images and stops until an explicit retry", async ({ page }) => {
  const metrics = await setup(page);
  await expect(previews(page)).toHaveCount(2);
  await page.evaluate(() => { document.documentElement.dataset.thumbnailError = "true"; });
  await page.clock.runFor(46_000);
  await expect(previews(page)).toHaveCount(0);
  const failed = await batches(page);
  await page.clock.runFor(120_000);
  expect(await batches(page)).toBe(failed);
  await page.evaluate(() => { document.documentElement.dataset.thumbnailError = "false"; });
  await page.getByRole("button", { name: "Retry preview", exact: true }).first().click();
  await page.clock.runFor(100);
  await expect(previews(page)).toHaveCount(1);
  await expect.poll(() => metrics.images.length).toBe(3);
});

test("image errors stop downloads until retry and evidence replacement clears the old source", async ({ page }) => {
  const metrics = await setup(page);
  await expect(previews(page)).toHaveCount(2);
  await page.getByRole("img", { name: "Application proof for Evidence 1", exact: true }).dispatchEvent("error");
  await expect(page.getByRole("button", { name: "Retry preview", exact: true })).toHaveCount(1);
  const failed = metrics.images.length;
  await page.clock.runFor(120_000);
  expect(metrics.images).toHaveLength(failed);
  await page.getByRole("button", { name: "Retry preview", exact: true }).click();
  await page.clock.runFor(100);
  await expect(previews(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Replace evidence", exact: true }).click();
  await page.clock.runFor(100);
  await expect(page.getByRole("img", { name: "Application proof for Evidence 1", exact: true })).toHaveAttribute("src", /egress-1-0/);
});

test("late authorization cannot restore a replaced actor or an unmounted image", async ({ page }) => {
  await setup(page);
  await expect(previews(page)).toHaveCount(2);
  await page.evaluate(() => { document.documentElement.dataset.delayNextFiles = "true"; });
  await page.clock.runFor(46_000);
  await page.getByRole("button", { name: "Change actor", exact: true }).click();
  await page.clock.runFor(100);
  await expect(page.getByRole("img", { name: "Application proof for Evidence 1", exact: true })).toHaveAttribute("src", /token=3/);
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-release-files")));
  await page.clock.runFor(100);
  await expect(page.getByRole("img", { name: "Application proof for Evidence 1", exact: true })).toHaveAttribute("src", /token=3/);
  await page.evaluate(() => { document.documentElement.dataset.delayNextFiles = "true"; });
  await page.clock.runFor(46_000);
  await page.getByRole("button", { name: "Unmount evidence", exact: true }).click();
  const before = await batches(page);
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-release-files")));
  await page.clock.runFor(120_000);
  await expect(previews(page)).toHaveCount(0);
  expect(await batches(page)).toBe(before);
});

test("slow authorization hides expired evidence without re-downloading after recovery", async ({ page }) => {
  const metrics = await setup(page);
  await expect(previews(page)).toHaveCount(2);
  await page.evaluate(() => { document.documentElement.dataset.delayNextFiles = "true"; });
  await page.clock.runFor(61_000);
  const image = page.getByRole("img", { name: "Application proof for Evidence 1", exact: true, includeHidden: true });
  await expect(image).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-release-files")));
  await page.clock.runFor(100);
  await expect(image).toBeVisible();
  expect(metrics.images).toHaveLength(2);
});

test("notification polling remains suspended while hidden", async ({ page }) => {
  await setup(page);
  await expect(previews(page)).toHaveCount(2);
  await page.clock.runFor(31_000);
  const before = await page.locator("html").getAttribute("data-egress-unread");
  await visible(page, "hidden");
  await page.clock.runFor(120_000);
  await expect(page.locator("html")).toHaveAttribute("data-egress-unread", before!);
  await visible(page, "visible");
  await page.clock.runFor(100);
  await expect(page.locator("html")).toHaveAttribute("data-egress-unread", String(Number(before) + 1));
});

test("an open dialog keeps renewing when its table cell leaves the viewport", async ({ page }) => {
  await setup(page);
  await expect(previews(page)).toHaveCount(2);
  await previews(page).first().click();
  await expect(page.getByRole("img", { name: "Enlarged application proof for Evidence 1" })).toBeVisible();
  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll("button")].find((button) => button.textContent === "Toggle offscreen");
    toggle?.click();
  });
  await page.clock.runFor(100);
  const before = await batches(page);
  await page.clock.runFor(46_000);
  await expect.poll(() => batches(page)).toBe(before + 1);
  await expect(page.getByRole("img", { name: "Enlarged application proof for Evidence 1" })).toHaveAttribute("src", /token=1/);
});

test("revocation clears evidence and cancels future renewal", async ({ page }) => {
  await setup(page);
  await expect(previews(page)).toHaveCount(2);
  const before = await batches(page);
  await page.evaluate(() => window.dispatchEvent(new Event("workspace-access-revoked")));
  await expect(previews(page)).toHaveCount(0);
  await page.clock.runFor(120_000);
  expect(await batches(page)).toBe(before);
});

test("late hidden-tab purge responses cannot overwrite the resumed poll", async ({ page }) => {
  await setup(page);
  await expect(previews(page)).toHaveCount(2);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  await page.route("**/api/read/purges**", async (route) => {
    const index = ++reads;
    if (index === 1) await pending;
    await route.fulfill({ contentType: "application/json", body: index === 1 ? '{"error":"Obsolete hidden response"}' : '{"data":[]}' });
  });
  await page.clock.runFor(31_000);
  await expect.poll(() => reads).toBe(1);
  await visible(page, "hidden");
  await visible(page, "visible");
  await page.clock.runFor(100);
  await expect.poll(() => reads).toBe(2);
  release();
  await page.clock.runFor(1000);
  await expect(page.getByTestId("purge-error")).toHaveText("false");
  expect(reads).toBe(2);
});

test("active purge polls every ten seconds and completion expires across hide/show", async ({ page }) => {
  await setup(page);
  await expect(previews(page)).toHaveCount(2);
  let reads = 0;
  const operation = { id: "synthetic-purge", scope: "Selected trashed bids", deletedCount: 1,
    pendingFiles: 1, awaitingRemovalFiles: 0, verifyingFiles: 1, processingFiles: 0, failedFiles: 0,
    nextAttemptAt: null, serverTime: "2026-10-16T12:00:30Z" };
  await page.route("**/api/read/purges**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: ++reads === 1 ? [operation] : [] }) }));
  await page.clock.runFor(31_000);
  await expect(page.getByTestId("purge-active")).toHaveText("1");
  await page.clock.runFor(10_000);
  await expect(page.getByTestId("purge-active")).toHaveText("0");
  await expect(page.getByTestId("purge-finished")).toHaveText("1");
  await visible(page, "hidden");
  await page.clock.runFor(2000);
  expect(reads).toBe(2);
  await visible(page, "visible");
  await page.clock.runFor(1000);
  expect(reads).toBe(3);
  await expect(page.getByTestId("purge-finished")).toHaveText("1");
  await page.clock.runFor(4000);
  await expect(page.getByTestId("purge-finished")).toHaveText("0");
  expect(reads).toBe(3);
});
