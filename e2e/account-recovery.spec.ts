import { test, expect } from "@playwright/test";
for (const loss of ["accepted", "lost"]) {
  test(`retains frozen request after ${loss} response and resumes after browser reload`, async ({
    page,
  }) => {
    await page.goto(
      `http://127.0.0.1:3001/admin-users?account-recovery=${loss}`,
    );
    await page
      .getByRole("button", { name: "Add client", exact: false })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Full name")).toBeEnabled();
    await dialog.getByLabel("Full name").fill("Recovered client");
    await dialog.getByLabel("Email address").fill("recovered@example.test");
    await dialog
      .getByRole("button", { name: "Create client", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Check and resume saved request" }),
    ).toBeVisible();
    await expect(dialog.getByLabel("Full name")).toBeDisabled();
    await expect(page.getByText("Client created", { exact: true })).toHaveCount(
      0,
    );
    const before = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("fixture-account-journal")!),
    );
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Pending account changes" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add client", exact: false })
      .click();
    await expect(
      dialog.getByText("Recovered client", { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Check and resume saved request" })
      .click();
    await expect(dialog).toHaveCount(0);
    const after = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("fixture-account-journal")!),
    );
    expect(after.requests).toEqual([
      before.operation.requestId,
      before.operation.requestId,
    ]);
    expect(after.effects).toBe(1);
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith("managed-account:"),
        ),
      ),
    ).toEqual([]);
  });
}
test("shows a pending operation in recovery immediately after closing its dialog", async ({
  page,
}) => {
  await page.goto(
    "http://127.0.0.1:3001/admin-users?account-recovery=accepted",
  );
  await page.getByRole("button", { name: "Add client", exact: false }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Full name")).toBeEnabled();
  await dialog.getByLabel("Full name").fill("Pending client");
  await dialog.getByLabel("Email address").fill("pending@example.test");
  await dialog
    .getByRole("button", { name: "Create client", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Check and resume saved request" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("region", { name: "Pending account changes" }),
  ).toBeVisible();
});
test("allows correcting a definitely rejected email without a phantom pending operation", async ({
  page,
}) => {
  await page.goto(
    "http://127.0.0.1:3001/admin-users?account-recovery=duplicate",
  );
  await page.getByRole("button", { name: "Add client", exact: false }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Full name")).toBeEnabled();
  await dialog.getByLabel("Full name").fill("Correctable client");
  await dialog.getByLabel("Email address").fill("existing@example.test");
  await dialog
    .getByRole("button", { name: "Create client", exact: true })
    .click();
  await expect(dialog.getByLabel("Email address")).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Check and resume saved request" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith("managed-account:"),
      ),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("fixture-account-journal"),
    ),
  ).toBeNull();
  await page.reload();
  await page.getByRole("button", { name: "Add client", exact: false }).click();
  await expect(dialog.getByLabel("Email address")).toBeEnabled();
  await dialog.getByLabel("Full name").fill("Correctable client");
  await dialog.getByLabel("Email address").fill("corrected@example.test");
  await dialog
    .getByRole("button", { name: "Create client", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Check and resume saved request" }),
  ).toBeVisible();
  const state = await page.evaluate(() => ({
    rejected: sessionStorage.getItem("fixture-account-rejected-request"),
    journal: JSON.parse(sessionStorage.getItem("fixture-account-journal")!),
  }));
  expect(state.journal.operation.requestId).not.toBe(state.rejected);
  expect(state.journal.operation.payload.email).toBe("corrected@example.test");
  expect(state.journal.effects).toBe(1);
});
