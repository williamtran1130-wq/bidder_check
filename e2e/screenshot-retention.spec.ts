import { test, expect } from "@playwright/test";
const origin = process.env.EGRESS_PREVIEW_ORIGIN ?? "http://127.0.0.1:3001";
test("bidder screenshots show upload status without downloading images or signing previews", async ({
  page,
}) => {
  let images = 0;
  await page.route("https://images.example.test/**", (route) => {
    images++;
    return route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
  });
  await page.goto(`${origin}/egress.html?egress&screenshot-sizes&count=2`);
  await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("img")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Open screenshot|Preview screenshot/ }),
  ).toHaveCount(0);
  expect(images).toBe(0);
  expect(
    Number(await page.locator("html").getAttribute("data-file-batch-reads")),
  ).toBe(0);
});
test("manager screenshots download only after explicit opening", async ({
  page,
}) => {
  let images = 0;
  await page.route("https://images.example.test/**", (route) => {
    images++;
    return route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>',
    });
  });
  await page.goto(
    `${origin}/egress.html?egress&screenshot-sizes&count=2&role=client`,
  );
  await expect(
    page.getByRole("button", { name: /Open screenshot for/ }),
  ).toHaveCount(2);
  expect(images).toBe(0);
  await page
    .getByRole("button", { name: /Open screenshot for/ })
    .first()
    .click();
  await expect(
    page.getByRole("img", { name: /Enlarged application proof/ }),
  ).toBeVisible();
  expect(images).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("img")).toHaveCount(0);
});
