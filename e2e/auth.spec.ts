import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("login is accessible and fits the viewport", async ({
  page,
}, testInfo) => {
  await page.goto("/auth/login");
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(
    scan.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/login-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test("protected routes lead to login and client registration is discoverable", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/auth\/login/);
  await expect(page.locator('input[name="next"]')).toHaveValue("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(
    page.getByRole("heading", { name: "Make room for progress." }),
  ).toBeVisible();
  await expect(page.getByLabel("Your name")).toBeVisible();
  await expect(
    page.getByText("Bidder accounts are created by their client."),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("login preserves a notification deep link for post-auth navigation", async ({
  page,
}) => {
  const destination = "/notifications?notification=notice-123";
  await page.goto(`/auth/login?next=${encodeURIComponent(destination)}`);
  await expect(page.locator('input[name="next"]')).toHaveValue(destination);
});
test("password visibility and recovery navigation work", async ({ page }) => {
  await page.goto("/auth/login");
  await page.getByLabel("Password", { exact: true }).fill("example-password");
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(
    page.getByRole("heading", { name: "Let’s get you back in." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to sign in" }),
  ).toBeVisible();
});
test("invalid confirmation links show a recoverable error", async ({
  page,
}) => {
  await page.goto("/auth/confirm?type=invalid");
  await expect(page).toHaveURL(/\/auth\/login\?error=/);
  await expect(
    page.getByRole("alert").filter({ hasText: "invalid or expired" }),
  ).toBeVisible();
});

test("retired notification endpoint returns Gone and retirement assets stay public", async ({ request }) => {
  const cron = await request.post("/api/cron/notifications", { maxRedirects: 0 });
  expect(cron.status()).toBe(410);
  expect(await cron.json()).toEqual({ error: "Notifications have been retired." });
  const worker = await request.get("/push-worker.js", { maxRedirects: 0 });
  expect(worker.status()).toBe(200);
  expect(await worker.text()).toContain('addEventListener("activate"');
  const manifest = await request.get("/manifest.webmanifest", { maxRedirects: 0 });
  expect(manifest.status()).toBe(200);
  expect(await manifest.json()).toMatchObject({ name: "Bidder Check" });
});
