import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
async function manage(page: import("@playwright/test").Page, mode = "success") {
  await page.goto(`http://127.0.0.1:3001/users?bidder-security=${mode}`);
  await page.getByLabel("Search people").fill("bidder0@example.test");
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  return page.getByRole("dialog");
}
test("sign-out requires confirmation and completes exactly once", async ({
  page,
}) => {
  const dialog = await manage(page);
  const button = dialog.getByRole("button", {
    name: "Sign out all devices",
    exact: true,
  });
  await expect(button).toBeDisabled();
  await dialog.getByLabel("Confirm sign out on all devices").check();
  await button.click();
  await expect(
    page.getByText("Bidder signed out on all devices", { exact: true }),
  ).toBeVisible();
  await expect(button).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(sessionStorage.getItem("fixture-bidder-security")!).effects,
    ),
  ).toBe(1);
});
test("custom password requires matching confirmation, clears on close and stays out of storage", async ({
  page,
}) => {
  const dialog = await manage(page);
  await expect(dialog.getByText(/Reset .*password to 123456/)).toHaveCount(0);
  const submit = dialog.getByRole("button", {
    name: "Change password",
    exact: true,
  });
  await dialog
    .getByLabel("New password", { exact: true })
    .fill("  private new password  ");
  await dialog
    .getByLabel("Confirm password", { exact: true })
    .fill("mismatched");
  await expect(submit).toBeDisabled();
  await dialog
    .getByLabel("Confirm password", { exact: true })
    .fill("  private new password  ");
  await expect(submit).toBeEnabled();
  const scan = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(
    scan.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
  await submit.click();
  await expect(
    page.getByText("Password changed. Bidder signed out on all devices.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.stringify([
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ]),
    ),
  ).not.toContain("private new password");
  await expect(dialog.getByLabel("New password", { exact: true })).toHaveValue(
    "",
  );
  await dialog
    .getByLabel("New password", { exact: true })
    .fill("unsaved secret");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(dialog.getByLabel("New password", { exact: true })).toHaveValue(
    "",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("reload recovers a password request with re-entry and the original request ID", async ({
  page,
}) => {
  let dialog = await manage(page, "recover");
  await dialog
    .getByLabel("New password", { exact: true })
    .fill("recover password");
  await dialog
    .getByLabel("Confirm password", { exact: true })
    .fill("recover password");
  await dialog
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Check and resume saved request" }),
  ).toBeVisible();
  const id = await page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem("fixture-bidder-security")!).operation
        .requestId,
  );
  await page.reload();
  await page.getByLabel("Search people").fill("bidder0@example.test");
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Check and resume saved request" })
    .click();
  await expect(
    dialog.getByText("Re-enter the original password to resume this request."),
  ).toBeVisible();
  await dialog
    .getByLabel("New password", { exact: true })
    .fill("recover password");
  await dialog
    .getByLabel("Confirm password", { exact: true })
    .fill("recover password");
  await dialog
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(
    page.getByText("Password changed. Bidder signed out on all devices.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(sessionStorage.getItem("fixture-bidder-security")!).operation
          .requestId,
    ),
  ).toBe(id);
});
