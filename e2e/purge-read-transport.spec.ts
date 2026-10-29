import { test, expect, type Page } from "@playwright/test";

const fixture = "http://127.0.0.1:3001";
type ReadRequest = { method: string; query: string | null };
async function transportFixture(
  page: Page,
  response: (attempt: number) => { data?: unknown[]; error?: string },
) {
  const reads: ReadRequest[] = [], blockedMutations: string[] = [];
  await page.clock.install({ time: new Date("2026-10-13T17:00:00Z") });
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.dataset.legacyPurgeReads ??= "0";
    });
  });
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== fixture) return route.abort();
    if (!["GET", "HEAD"].includes(request.method())) {
      blockedMutations.push(url.pathname);
      return route.abort();
    }
    if (url.pathname === "/api/read/purges") {
      reads.push({ method: request.method(), query: url.searchParams.get("q") });
      const body = response(reads.length);
      return route.fulfill({
        status: body.error ? 503 : 200,
        contentType: "application/json",
        headers: { "cache-control": "private, no-store", vary: "Cookie" },
        body: JSON.stringify(body),
      });
    }
    return route.continue();
  });
  return { reads, blockedMutations };
}
async function noLegacyReads(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-legacy-purge-reads", "0");
}

for (const role of ["client", "admin"]) {
  test(`${role} cleanup mount and idle polling use GET, retain errors and recover without an action POST`, async ({ page }) => {
    const transport = await transportFixture(page, attempt =>
      attempt === 2 ? { error: "Synthetic status unavailable" } : { data: [] },
    );
    await page.goto(`${fixture}/bids?purge-read-transport&role=${role}`);
    await expect(page.getByRole("grid", { name: "Bid applications", exact: true })).toBeVisible();
    await noLegacyReads(page);
    await expect.poll(() => transport.reads.length).toBe(1);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.clock.fastForward(30_100);
    await expect.poll(() => transport.reads.length).toBe(2);
    await expect(page.getByRole("alert")).toHaveText(/File cleanup status could not be refreshed/);
    await page.clock.fastForward(30_100);
    await expect.poll(() => transport.reads.length).toBe(3);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await noLegacyReads(page);
    expect(transport.reads).toEqual(Array.from({ length: 3 }, () => ({ method: "GET", query: "null" })));
    expect(transport.blockedMutations).toEqual([]);
  });
}

test("active cleanup GET polling retains status through failure and shows completion", async ({ page }) => {
  const pending = {
    id: "fixture-operation", scope: "Selected trashed bids", deletedCount: 15,
    pendingFiles: 1, awaitingRemovalFiles: 0, verifyingFiles: 1,
    processingFiles: 0, failedFiles: 0,
    nextAttemptAt: "2026-10-13T17:10:00Z", serverTime: "2026-10-13T17:00:00Z",
  };
  const transport = await transportFixture(page, attempt =>
    attempt === 1 ? { data: [pending] } :
      attempt === 2 ? { error: "Synthetic status unavailable" } : { data: [] },
  );
  await page.goto(`${fixture}/bids?purge-read-transport`);
  await expect(page.getByRole("grid", { name: "Bid applications", exact: true })).toBeVisible();
  await noLegacyReads(page);
  const notice = page.getByRole("status").filter({ hasText: "15 applications deleted" });
  await expect(notice).toContainText("Screenshots removed");
  await page.clock.fastForward(10_100);
  await expect.poll(() => transport.reads.length).toBe(2);
  await expect(page.getByRole("alert")).toHaveText(/File cleanup status could not be refreshed/);
  await expect(notice).toContainText("Screenshots removed");
  await page.clock.fastForward(10_100);
  await expect.poll(() => transport.reads.length).toBe(3);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(notice).toContainText("Cleanup complete");
  await page.clock.fastForward(6_100);
  await expect(notice).toHaveCount(0);
  await noLegacyReads(page);
  expect(transport.blockedMutations).toEqual([]);
});

test("bidder mount and elapsed polling windows issue no purge read or action", async ({ page }) => {
  const transport = await transportFixture(page, () => ({ data: [] }));
  await page.goto(`${fixture}/bids?purge-read-transport&role=bidder`);
  await expect(page.getByRole("grid", { name: "Bid applications", exact: true })).toBeVisible();
  await page.clock.fastForward(61_000);
  await page.clock.runFor(100);
  expect(transport.reads).toEqual([]);
  expect(transport.blockedMutations).toEqual([]);
  await noLegacyReads(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

