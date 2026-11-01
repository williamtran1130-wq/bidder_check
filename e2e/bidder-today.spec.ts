import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-01T18:00:00Z"));
});

test("bidder Today seed includes the older backlog in counts, search and pagination", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids?role=bidder&bid-seed");
  await expect(page.getByLabel("Found period")).toHaveValue("today");
  await expect(page.getByText("1–4 of 4 bids", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^All bids/ })).toHaveText(
    "All bids4",
  );
  await expect(page.getByRole("button", { name: /^unapplied/i })).toHaveText(
    "unapplied4",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-bid-list-reads",
    "0",
  );
  await expect(
    page.getByRole("gridcell", { name: "Figma", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Rows per page", { exact: true })
    .selectOption("custom");
  await page.getByLabel("Custom rows per page").fill("2");
  await expect(page.getByText("1–2 of 4 bids", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("3–4 of 4 bids", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("gridcell", { name: "Retool", exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search bids" }).fill("Figma");
  await expect(page.getByText("1–1 of 1 bids", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("gridcell", { name: "Figma", exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search bids" }).fill("");
  await page.getByLabel("Found period").selectOption("yesterday");
  await expect(page.getByText("0–0 of 0 bids", { exact: true })).toBeVisible();
  await page.getByLabel("Found period").selectOption("today");
  await expect(page.getByText("1–2 of 4 bids", { exact: true })).toBeVisible();
});

test("an older URL leaves Today on application and returns when unapplied", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids?role=bidder");
  await expect(page.getByText("1–4 of 4 bids", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View UI Engineer at Figma" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Waiting for client review before proof upload."),
  ).toBeVisible();
  await expect(dialog.getByLabel("Choose screenshot")).toBeDisabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("fixture-change-bid", {
        detail: {
          id: "bid-3",
          patch: { applied: true, applied_at: "2026-11-01T18:00:00Z" },
        },
      }),
    );
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.getByText("1–3 of 3 bids", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("gridcell", { name: "Figma", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Found period").selectOption("all");
  await expect(
    page.getByRole("gridcell", { name: "Figma", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Found period").selectOption("today");
  await expect(page.getByText("1–3 of 3 bids", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("fixture-change-bid", {
        detail: { id: "bid-3", patch: { applied: false, applied_at: null } },
      }),
    );
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.getByText("1–4 of 4 bids", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("gridcell", { name: "Figma", exact: true }),
  ).toBeVisible();
});

test("client and admin Today views retain their original found-date filter", async ({
  page,
}) => {
  for (const role of ["client", "admin"]) {
    await page.goto(`http://127.0.0.1:3001/bids?role=${role}&bid-seed`);
    await expect(
      page.getByText("1–1 of 1 bids", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("gridcell", { name: "Figma", exact: true }),
    ).toHaveCount(0);
  }
});
