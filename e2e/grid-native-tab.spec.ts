import { expect, test, type Page } from "@playwright/test";

const fixture = "http://127.0.0.1:3001";
const firstCompany = '[data-grid-r="0"][data-field="company"]';

// Hold the real grid's deferred focus until after native keyboard navigation.
// This makes the already observed ArrowUp/Tab race deterministic.
async function holdAnimationFrames(page: Page) {
  await page.evaluate(() => {
    const request = window.requestAnimationFrame;
    const cancel = window.cancelAnimationFrame;
    const held = new Map<number, FrameRequestCallback>();
    let id = 1000000;
    window.requestAnimationFrame = (callback) => {
      held.set(++id, callback);
      return id;
    };
    window.cancelAnimationFrame = (frame) => {
      held.delete(frame);
      cancel(frame);
    };
    (window as typeof window & { releaseGridFrames?: () => Promise<void> })
      .releaseGridFrames = async () => {
      window.requestAnimationFrame = request;
      window.cancelAnimationFrame = cancel;
      for (const callback of held.values()) callback(performance.now());
      held.clear();
      await new Promise<void>((resolve) =>
        request(() => request(() => resolve())),
      );
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === fixture
      ? route.continue()
      : route.abort(),
  );
  await page.routeWebSocket("**/*", (socket) => socket.close());
  await page.goto(`${fixture}/bids`);
  await page.getByLabel("Found period", { exact: true }).selectOption("all");
  await expect(page.locator('[data-grid-r="1"][data-field="company"]'))
    .toBeVisible();
});

for (const { key, origin } of [
  { key: "Tab", origin: "cell" },
  { key: "Shift+Tab", origin: "cell" },
  { key: "Tab", origin: "link" },
]) {
  test(`pending arrow focus cannot steal native ${key} from a ${origin}`, async ({ page }) => {
    const cell = page.locator(firstCompany);
    await cell.click();
    await expect(cell).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator('[data-grid-r="1"][data-field="company"]'))
      .toBeFocused();

    await holdAnimationFrames(page);
    await page.keyboard.press("ArrowUp");
    await expect(cell).toHaveAttribute("tabindex", "0");
    const start = origin === "cell"
      ? cell
      : page.locator('[data-grid-r="0"][data-field="url"] a');
    await start.focus();
    await page.keyboard.press(key);
    const nativeDestination = await page.evaluateHandle(() => document.activeElement);
    expect(await nativeDestination.evaluate((element, selector) =>
      element !== document.body && !element?.matches(selector), firstCompany))
      .toBe(true);
    await page.evaluate(() =>
      (window as typeof window & { releaseGridFrames: () => Promise<void> })
        .releaseGridFrames(),
    );
    expect(await nativeDestination.evaluate((element) =>
      document.activeElement === element)).toBe(true);
    await expect(page.getByRole("textbox", { name: "Edit company", exact: true }))
      .toHaveCount(0);
  });
}

for (const { key, field, next } of [
  { key: "Tab", field: "company", next: "role_name" },
  { key: "Shift+Tab", field: "role_name", next: "company" },
]) {
  test(`editor ${key} still saves once and focuses the adjacent cell`, async ({ page }) => {
    const cell = page.locator(`[data-grid-r="0"][data-field="${field}"]`);
    await cell.dblclick();
    const editor = page.getByRole("textbox", { name: `Edit ${field}`, exact: true });
    await editor.fill("Keyboard saved draft");
    await editor.press(key);
    await expect(editor).toHaveCount(0);
    await expect(cell).toContainText("Keyboard saved draft");
    await expect(page.locator(`[data-grid-r="0"][data-field="${next}"]`))
      .toBeFocused();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}
