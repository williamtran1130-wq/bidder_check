import { test, expect } from "@playwright/test";
test("matching seed avoids hydration query; stale generation cannot replace mutation refresh; timeout is user retried", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/read.html");
  await expect(page.getByTestId("report-data")).toHaveText("seed");
  await expect(page.getByTestId("request-count")).toHaveText("0");
  await page.getByRole("button", { name: "Query B", exact: true }).click();
  await expect(page.getByTestId("report-data")).toHaveText("empty");
  await page
    .getByRole("button", { name: "Refresh mutation", exact: true })
    .click();
  await expect(page.getByTestId("request-count")).toHaveText("2");
  await page
    .getByRole("button", { name: "Resolve newest", exact: true })
    .click();
  await expect(page.getByTestId("report-data")).toHaveText("fresh");
  await page
    .getByRole("button", { name: "Resolve oldest", exact: true })
    .click();
  await expect(page.getByTestId("report-data")).toHaveText("fresh");
  await page.getByRole("button", { name: "Timeout", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Timeout. Please retry.");
  await page.waitForTimeout(700);
  await expect(page.getByTestId("request-count")).toHaveText("3");
  await expect(page.getByTestId("report-data")).toHaveText("fresh");
  await page.getByRole("button", { name: "Query C", exact: true }).click();
  await expect(page.getByTestId("report-data")).toHaveText("empty");
  await page.screenshot({
    path: ".superpowers/sdd/2026-10-13-feature-preserving-improvements/task7-report-state.png",
  });
});
test("closed screenshots sign nothing and opening signs only the requested current file", async ({
  page,
}) => {
  await page.route("https://images.example.test/proof.png", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="green"/></svg>',
    }),
  );
  await page.goto("http://127.0.0.1:3001/bids?screenshot-sizes");
  await page
    .getByRole("combobox", { name: "Found period" })
    .selectOption("all");
  await page
    .getByLabel(
      "Screenshot paste target for Linear. Focus and press Ctrl+V or Command+V.",
      { exact: true },
    )
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: /Open screenshot for/ }).first(),
  ).toBeVisible();
  expect(Number(await page.locator("html").getAttribute("data-file-batch-reads"))).toBe(0);
  await page.getByRole("button",{name:/Open screenshot for/}).first().click();
  await expect(page.getByRole("img",{name:/Enlarged application proof/})).toBeVisible();
  const batches = await page
    .locator("html")
    .getAttribute("data-file-batch-reads");
  const ids = JSON.parse(
    (await page.locator("html").getAttribute("data-file-batch-ids")) ?? "[]",
  );
  expect(Number(batches)).toBeLessThanOrEqual(2);
  expect(ids.length).toBe(1);
  expect(ids.every((id: string) => id.startsWith("screenshot-"))).toBe(true);
  await page.screenshot({
    path: ".superpowers/sdd/2026-10-13-feature-preserving-improvements/task7-thumbnail-batch.png",
  });
});

test("auth failure clears the private workspace before navigation", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/read.html");
  await expect(page.getByTestId("private-scope")).toHaveText("Private proof");
  await page
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  await expect(page.getByTestId("private-scope")).toHaveCount(0);
});
