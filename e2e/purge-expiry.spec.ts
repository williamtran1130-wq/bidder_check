import { expect, test, type Page } from "@playwright/test";

const fixture = "http://127.0.0.1:3001";
type Observation = {
  phase: string;
  id: string;
  expiresAt: string;
  count: number;
  at: number;
};
async function observations(page: Page): Promise<Observation[]> {
  return page.evaluate(() =>
    JSON.parse(
      document.documentElement.dataset.purgeExpiryObservations ?? "[]",
    ),
  );
}
test("expired purge confirmation retains selected rows and requires a fresh confirmation", async ({
  page,
}, testInfo) => {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === fixture
      ? route.continue()
      : route.abort(),
  );
  await page.routeWebSocket("**/*", (socket) => socket.close());
  // Date changes without running ten minutes of polling/animation timers.
  await page.clock.setFixedTime(new Date("2026-10-13T17:00:00Z"));
  await page.addInitScript(() => {
    const events: unknown[] = [];
    window.addEventListener("fixture-purge-expiry", (event) => {
      events.push((event as CustomEvent).detail);
      document.documentElement.dataset.purgeExpiryObservations =
        JSON.stringify(events);
    });
  });
  await page.goto(`${fixture}/bids?purge-expiry`);
  await page.getByLabel("Found period", { exact: true }).selectOption("all");
  await page
    .getByRole("checkbox", { name: "Select bid at Linear", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Move selected to trash", exact: true })
    .click();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  // The modal correctly hides its background from the accessibility tree.
  // Inspect retained background state explicitly while the dialog is open.
  const selected = page.getByRole("checkbox", {
    name: "Select bid at Linear",
    exact: true,
    includeHidden: true,
  });
  const row = page.locator('[data-grid-r="0"][data-field="company"]');
  await selected.check();
  const prepare = page.getByRole("button", {
    name: "Delete selected permanently",
    exact: true,
  });
  await prepare.click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Permanently delete 1 bids?" }),
  ).toBeVisible();
  const [first] = await observations(page);
  expect(first.phase).toBe("prepared");
  expect(Date.parse(first.expiresAt)).toBeGreaterThan(first.at);
  await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
  await page.screenshot({
    path: testInfo.outputPath("01-prepared.png"),
    fullPage: true,
  });

  await page.clock.setFixedTime(new Date(Date.parse(first.expiresAt) + 1));
  await dialog
    .getByRole("button", { name: "Permanently delete", exact: true })
    .click();
  const expired = dialog.getByRole("alert");
  await expect(expired).toContainText(
    "Confirmation expired. Prepare a new confirmation",
  );
  await expect(expired).toContainText(
    "Close this dialog and prepare a new confirmation",
  );
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Permanently delete", exact: true }),
  ).toBeEnabled();
  await expect(selected).toBeChecked();
  await expect(row).toHaveText("Linear");
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(page.getByText(/1 application permanently deleted/)).toHaveCount(
    0,
  );
  await expect(
    page.getByText(/Screenshot cleanup complete|1 application deleted/),
  ).toHaveCount(0);
  expect(
    (await observations(page)).map(({ phase, id }) => ({ phase, id })),
  ).toEqual([
    { phase: "prepared", id: first.id },
    { phase: "confirm", id: first.id },
    { phase: "expired", id: first.id },
  ]);
  expect((await observations(page))[2].at).toBeGreaterThan(
    Date.parse(first.expiresAt),
  );
  await page.screenshot({
    path: testInfo.outputPath("02-expired-retained.png"),
    fullPage: true,
  });

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(selected).toBeChecked();
  await prepare.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Type DELETE to confirm")).toHaveValue("");
  const all = await observations(page);
  const second = all[3];
  expect(second.phase).toBe("prepared");
  expect(second.id).not.toBe(first.id);
  expect(Date.parse(second.expiresAt)).toBeGreaterThan(second.at);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByLabel("Type DELETE to confirm")).toHaveValue("");
  await expect(
    dialog.getByRole("button", { name: "Permanently delete", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
  await dialog
    .getByRole("button", { name: "Permanently delete", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText(
      "1 application permanently deleted; screenshot cleanup complete",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(selected).toHaveCount(0);
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();
  expect(
    (await observations(page)).slice(4).map(({ phase, id }) => ({ phase, id })),
  ).toEqual([
    { phase: "confirm", id: second.id },
    { phase: "deleted", id: second.id },
  ]);
  await page
    .getByRole("button", { name: "Back to active bids", exact: true })
    .click();
  await expect(
    page.getByRole("gridcell", { name: "Notion", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select bid at Linear", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("03-fresh-confirmation-complete.png"),
    fullPage: true,
  });
});
