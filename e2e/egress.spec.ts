import { test, expect, type Page } from "@playwright/test";

const origin = process.env.EGRESS_PREVIEW_ORIGIN ?? "http://127.0.0.1:3001";
const imageBody =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="green"/></svg>';
async function setup(page: Page, count = 2, role = "bidder") {
  await page.clock.install({ time: new Date("2026-10-16T12:00:00Z") });
  await page.addInitScript(() => {
    const Observer = window.IntersectionObserver;
    window.IntersectionObserver = class extends Observer {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        super((entries, observer) => {
          for (const entry of entries)
            entry.target.setAttribute(
              "data-fixture-intersecting",
              String(entry.isIntersecting),
            );
          callback(entries, observer);
        }, options);
      }
    };
    let visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      get: () => visibility,
    });
    Object.defineProperty(window, "setFixtureVisibility", {
      value: (next: string) => {
        visibility = next;
        document.dispatchEvent(new Event("visibilitychange"));
      },
    });
  });
  const images: string[] = [];
  let purgeReads = 0;
  await page.route("https://images.example.test/**", (route) => {
    images.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      contentType: "image/svg+xml",
      headers: { "cache-control": "no-store" },
      body: imageBody,
    });
  });
  await page.route("**/api/read/purges**", (route) => {
    purgeReads++;
    return route.fulfill({
      contentType: "application/json",
      body: '{"data":[]}',
    });
  });
  await page.goto(
    `${origin}/egress.html?egress&screenshot-sizes&purge-read-transport&count=${count}&role=${role}`,
  );
  return { images, purgeReads: () => purgeReads };
}
async function visible(page: Page, value: "visible" | "hidden") {
  await page.evaluate((state) => {
    (
      window as unknown as { setFixtureVisibility: (next: string) => void }
    ).setFixtureVisibility(state);
  }, value);
}
const previews = (page: Page) =>
  page.getByRole("button", { name: /Open screenshot for/ });
const batches = async (page: Page) =>
  Number(await page.locator("html").getAttribute("data-file-batch-reads"));

test("25 bidder cells make zero preview requests over five minutes", async ({
  page,
}) => {
  const metrics = await setup(page, 25);
  await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(25);
  await page.clock.runFor(300_000);
  expect(metrics.images).toHaveLength(0);
  expect(await batches(page)).toBe(0);
  await expect(previews(page)).toHaveCount(0);
});
test("only an open manager dialog renews authorization without downloading its image again", async ({
  page,
}) => {
  const metrics = await setup(page, 2, "client");
  await expect(previews(page)).toHaveCount(2);
  expect(metrics.images).toHaveLength(0);
  await previews(page).first().click();
  await expect(
    page.getByRole("img", { name: /Enlarged application proof/ }),
  ).toBeVisible();
  await expect.poll(() => batches(page)).toBe(1);
  await page.clock.runFor(46_000);
  await expect.poll(() => batches(page)).toBe(2);
  expect(metrics.images).toHaveLength(1);
  await page.keyboard.press("Escape");
  const signed = await batches(page);
  await page.clock.runFor(120_000);
  expect(await batches(page)).toBe(signed);
});
test("hidden tabs suspend preview renewal and notification polling", async ({
  page,
}) => {
  await setup(page, 2, "client");
  await previews(page).first().click();
  await expect(
    page.getByRole("img", { name: /Enlarged application proof/ }),
  ).toBeVisible();
  await page.clock.runFor(31_000);
  await visible(page, "hidden");
  const signed = await batches(page);
  const unread = await page.locator("html").getAttribute("data-egress-unread");
  await page.clock.runFor(120_000);
  expect(await batches(page)).toBe(signed);
  await expect(page.locator("html")).toHaveAttribute(
    "data-egress-unread",
    unread!,
  );
  await visible(page, "visible");
  await page.clock.runFor(100);
  await expect.poll(() => batches(page)).toBe(signed + 1);
});
test("revocation clears an open screenshot and stops authorization renewal", async ({
  page,
}) => {
  await setup(page, 2, "client");
  await previews(page).first().click();
  await expect(
    page.getByRole("img", { name: /Enlarged application proof/ }),
  ).toBeVisible();
  const signed = await batches(page);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("workspace-access-revoked")),
  );
  await expect(page.getByRole("img")).toHaveCount(0);
  await page.clock.runFor(120_000);
  expect(await batches(page)).toBe(signed);
});
test("late hidden-tab purge responses cannot overwrite the resumed poll", async ({
  page,
}) => {
  await setup(page);
  await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(2);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  await page.route("**/api/read/purges**", async (route) => {
    const index = ++reads;
    if (index === 1) await pending;
    await route.fulfill({
      contentType: "application/json",
      body:
        index === 1 ? '{"error":"Obsolete hidden response"}' : '{"data":[]}',
    });
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

test("active purge polls every ten seconds and completion expires across hide/show", async ({
  page,
}) => {
  await setup(page);
  await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(2);
  let reads = 0;
  const operation = {
    id: "synthetic-purge",
    scope: "Selected trashed bids",
    deletedCount: 1,
    pendingFiles: 1,
    awaitingRemovalFiles: 0,
    verifyingFiles: 1,
    processingFiles: 0,
    failedFiles: 0,
    nextAttemptAt: null,
    serverTime: "2026-10-16T12:00:30Z",
  };
  await page.route("**/api/read/purges**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: ++reads === 1 ? [operation] : [] }),
    }),
  );
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
