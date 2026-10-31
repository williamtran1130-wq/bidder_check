import { test, expect, type Page } from "@playwright/test";
const base =
  "http://127.0.0.1:3001/read-fixes.html?screenshot-sizes&read-fixes";
async function open(page: Page) {
  await page.route("https://images.example.test/proof.png", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="green"/></svg>',
    }),
  );
  await page.goto(base);
}

test("two remounted consumers renew a44-second-old cached URL before expiry", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-13T12:00:00Z") });
  await open(page);
  await expect(
    page.getByRole("button", { name: /Preview screenshot for/ }),
  ).toHaveCount(2);
  await expect(page.locator("html")).toHaveAttribute(
    "data-file-batch-reads",
    "1",
  );
  await page
    .getByRole("button", { name: "Hide thumbnails", exact: true })
    .click();
  await page.clock.fastForward(44000);
  await page
    .getByRole("button", { name: "Show thumbnails", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Preview screenshot for/ }),
  ).toHaveCount(2);
  await expect(page.locator("html")).toHaveAttribute(
    "data-file-batch-reads",
    "1",
  );
  await page.clock.runFor(2100);
  await expect(page.locator("html")).toHaveAttribute(
    "data-file-batch-reads",
    "2",
  );
});
test("failed thumbnail renewal stops automatic attempts until explicit retry", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-13T12:00:00Z") });
  await open(page);
  await expect(
    page.getByRole("button", { name: /Preview screenshot for/ }),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Fail thumbnail reads", exact: true })
    .click();
  await page.clock.runFor(46000);
  await expect(
    page.getByRole("button", { name: "Retry preview", exact: true }),
  ).toHaveCount(2);
  const count = await page
    .locator("html")
    .getAttribute("data-file-batch-reads");
  await page.clock.fastForward(120000);
  await page.clock.runFor(100);
  await expect(page.locator("html")).toHaveAttribute(
    "data-file-batch-reads",
    count!,
  );
  await page
    .getByRole("button", { name: "Retry preview", exact: true })
    .first()
    .click();
  await page.clock.runFor(50);
  await expect(page.locator("html")).toHaveAttribute(
    "data-file-batch-reads",
    String(Number(count) + 1),
  );
});

test("file and scope changes cancel the previous thumbnail renewal", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-13T12:00:00Z") });
  await open(page);
  await expect(
    page.getByRole("button", { name: /Preview screenshot for/ }),
  ).toHaveCount(2);
  await page.clock.fastForward(30000);
  await page
    .getByRole("button", { name: "Change thumbnail file", exact: true })
    .click();
  await page.clock.runFor(100);
  await expect(page.locator("html")).toHaveAttribute(
    "data-file-batch-reads",
    "2",
  );
  await page.clock.fastForward(16000);
  await page.clock.runFor(100);
  await expect(page.locator("html")).toHaveAttribute(
    "data-file-batch-reads",
    "2",
  );
  await page
    .getByRole("button", { name: "Change thumbnail scope", exact: true })
    .click();
  await page.clock.runFor(100);
  await expect(page.locator("html")).toHaveAttribute(
    "data-file-batch-reads",
    "3",
  );
  await page.clock.fastForward(30000);
  await page.clock.runFor(100);
  await expect(page.locator("html")).toHaveAttribute(
    "data-file-batch-reads",
    "3",
  );
});
