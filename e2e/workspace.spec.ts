import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("dashboard has real component layout, responsive navigation, and no serious accessibility issues", async ({
  page,
}, testInfo) => {
  await page.goto("http://127.0.0.1:3001/dashboard");
  await expect(
    page.getByRole("heading", { name: "Welcome back, Alex." }),
  ).toBeVisible();
  await expect(page.getByText("Earned", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Application activity" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "By bidder" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "By profile" })).toBeVisible();
  await expect(page.getByText(/CT/).first()).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(
    scan.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/dashboard-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  const axisLabels = page.locator(".recharts-cartesian-axis-tick-value");
  await expect(axisLabels.first()).toBeVisible();
  const contrast = await axisLabels.evaluateAll((labels) => {
    const luminance = (color: string) => {
      const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    return labels.map((label) => {
      const foreground = luminance(getComputedStyle(label).fill);
      const background = luminance(getComputedStyle(label.closest("section")!).backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
  });
  expect(Math.min(...contrast)).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({
    path: `test-results/dashboard-dark-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test("bid table search, filters and details show the correct application", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids");
  await expect(
    page.getByRole("heading", { name: "Your bid workspace." }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search bids" }).fill("Linear");
  await expect(
    page.getByRole("gridcell", { name: "Linear", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("1–1 of 1 bids")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "View Senior Frontend Engineer at Linear" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Senior Frontend Engineer" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mark as applied" }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("dialog")
      .getByText("Waiting for client review before proof upload."),
  ).toBeVisible();
  await expect(page.getByLabel("Choose screenshot")).toBeDisabled();
});
test("resume details and earnings render their scoped data", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/resumes");
  await page.getByRole("button", { name: /ENG-01 Jamie Parker/ }).click();
  await expect(
    page.getByText("APPLICATION INSTRUCTIONS", { exact: true }),
  ).toBeVisible();
  await page.goto("http://127.0.0.1:3001/earnings");
  await expect(
    page.getByRole("heading", { name: "Every effort adds up." }),
  ).toBeVisible();
  await expect(page.getByText("$10.00").first()).toBeVisible();
});

test("daily table has ordered workflow columns, automatic timestamps and trash controls", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids");
  await expect(
    page.getByLabel("Found period"),
  ).toHaveValue("today");
  await expect(page.getByRole("columnheader")).toHaveText([
    "",
    "#",
    "Added date (CT)",
    "Profile ID",
    "Company name",
    "Role",
    "Link",
    "Bidder ID",
    "Job site",
    "Applied status",
    "Applied time (CT)",
    "Work arrangement",
    "Job status",
    "Review status",
    "Interview status",
    "Screenshot",
    "Actions",
  ]);
  await expect(page.getByText("1\u20131 of 1 bids")).toBeVisible();
  await page.getByLabel("Found period").selectOption("all");
  await expect(page.getByText("1\u201310 of 12 bids")).toBeVisible();
  await page.getByRole("button", { name: "Add bid", exact: true }).click();
  await expect(page.getByLabel(/Found time/)).toHaveCount(0);
});
test("dashboard review link opens the all-dates pending review queue", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/bids?review=pending");
  await expect(page.getByRole("button", { name: /Pending review/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Found period")).toHaveValue("all");
  await expect(page.getByRole("gridcell", { name: "pending Approve Reject" }).first()).toBeVisible();
  expect(await page.getByRole("row").count()).toBeGreaterThan(2);
});

test("column controls filter across current results and page size is customizable", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/bids");
  await page.getByLabel("Found period").selectOption("all");
  await page.getByRole("button", { name: "Filter Company name" }).click();
  await page.getByLabel("Company name filter").fill("Linear");
  await expect(page.getByText("1–1 of 1 bids")).toBeVisible();
  await page.getByLabel("Rows per page", { exact: true }).selectOption("custom");
  await page.getByLabel("Custom rows per page").fill("25");
  await expect(page.getByLabel("Custom rows per page")).toHaveValue("25");
});

test("spreadsheet keyboard edits preserve drafts, focus and rectangular copying", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids");
  const company = page.locator('[data-grid-r="0"][data-field="company"]');
  await company.click();
  await page.keyboard.press("F2");
  const editor = page.getByRole("textbox", {
    name: "Edit company",
    exact: true,
  });
  await editor.fill("");
  await editor.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Required");
  await editor.fill("Grid Company");
  await editor.press("Enter");
  await expect(company).toContainText("Grid Company");
  await expect(company).toBeFocused();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(
    page.locator('[role="gridcell"][aria-selected="true"]'),
  ).toHaveCount(2);
  const copied = await company.evaluate((el) => {
    const data = new DataTransfer();
    el.dispatchEvent(
      new ClipboardEvent("copy", { bubbles: true, clipboardData: data }),
    );
    return data.getData("text/plain");
  });
  expect(copied).toBe("Grid Company\tSenior Frontend Engineer");
  await page.keyboard.press("F2");
  await page.getByRole("textbox", { name: "Edit role_name" }).fill("Unsaved");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Edit role_name" }),
  ).toHaveCount(0);
  await page.getByLabel("Found period").selectOption("yesterday");
  await expect(page.getByText("1\u20131 of 1 bids")).toBeVisible();
  await expect(
    page.locator('[role="gridcell"][aria-selected="true"]'),
  ).toHaveCount(0);
});
test("Sheets mapping keeps blocked rows visible and allows valid rows to import", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids");
  await page
    .getByRole("button", { name: "Paste from Sheets", exact: true })
    .click();
  await page
    .getByLabel("Import bidder", { exact: true })
    .selectOption("bidder-0");
  await page
    .getByLabel("Import resume", { exact: true })
    .selectOption("resume-0");
  await page
    .getByLabel("Copied Google Sheets cells")
    .fill("Acme\tEngineer\thttps://example.com/one\nTokyo\tDesigner\tbad-url");
  await page.getByRole("button", { name: "Read columns" }).click();
  await page.getByRole("button", { name: "Preview bids" }).click();
  await expect(
    page.getByRole("button", { name: "Import 1 allowed bids", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText("Blocked", { exact: true })).toHaveCount(1);
  await expect(page.getByLabel("Row 2 Job URL", { exact: true })).toHaveText("bad-url");
  await expect(page.getByRole("dialog").getByRole("table").getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Remove row/ })).toHaveCount(0);
  await expect(page.getByText("Enter a valid HTTP/HTTPS URL", { exact: false })).toHaveCount(0);
});
test("imports only allowed Sheets rows with a concise count and no skipped-row report", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/bids");
  await page.getByRole("button", { name: "Paste from Sheets", exact: true }).click();
  await page.getByLabel("Import bidder", { exact: true }).selectOption("bidder-0");
  await page.getByLabel("Import resume", { exact: true }).selectOption("resume-0");
  await page.getByLabel("Copied Google Sheets cells").fill("Acme\tEngineer\thttps://example.com/allowed\nTokyo\tDesigner\tbad-url");
  await page.getByRole("button", { name: "Read columns" }).click();
  await page.getByRole("button", { name: "Preview bids" }).click();
  await expect(page.getByRole("button", { name: "Import 1 allowed bids", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Import 1 allowed bids", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Paste new bids from Sheets" })).toHaveCount(0);
  await expect(page.getByText("1 bid added", { exact: false })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-last-import-count", "1");
  await expect(page.getByRole("button", { name: "Download skipped rows" })).toHaveCount(0);
  await expect(page.getByText(/row skipped/)).toHaveCount(0);
});
test("fresh import conflicts add only eligible rows with no failure report", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/bids?fresh-conflict");
  await page.getByRole("button", { name: "Paste from Sheets", exact: true }).click();
  await page.getByLabel("Import bidder", { exact: true }).selectOption("bidder-0");
  await page.getByLabel("Import resume", { exact: true }).selectOption("resume-0");
  await page.getByLabel("Copied Google Sheets cells").fill("Acme\tEngineer\thttps://example.com/one\nTokyo\tDesigner\thttps://example.com/two");
  await page.getByRole("button", { name: "Read columns" }).click();
  await page.getByRole("button", { name: "Preview bids" }).click();
  await expect(page.getByText("Allowed", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Import 2 allowed bids", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-last-import-count", "1");
  await expect(page.getByText("1 bid added", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download skipped rows" })).toHaveCount(0);
  await expect(page.getByText("already has an application", { exact: false })).toHaveCount(0);
});
test("pasting an image into the selected screenshot cell uploads only to that bid", async ({ page }) => {
  let uploadRequests = 0;
  await page.route("**/storage/v1/object/private-files/**", (route) => { uploadRequests += 1; return route.fulfill({ status: 200, body: "stored" }); });
  await page.goto("http://127.0.0.1:3001/bids?paste-screenshot");
  await page.getByLabel("Found period").selectOption("all");
  const target = page.locator('[data-grid-r="1"][data-field="screenshot"] [aria-label^="Screenshot paste target"]');
  await expect(target).toBeVisible();
  const clipboard = await target.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" }));
    const item = transfer.items[0];
    element.focus();
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
    return { kind: item?.kind, type: item?.type, fileCount: transfer.files.length };
  });
  expect(clipboard).toEqual({ kind: "file", type: "image/png", fileCount: 1 });
  await expect(page.locator("html")).toHaveAttribute("data-screenshot-prepared", "bid-1");
  await expect.poll(() => uploadRequests).toBe(1);
  await expect(page.locator("html")).toHaveAttribute("data-screenshot-finalized", "fixture-screenshot-upload");
  await expect(page.getByRole("heading", { name: "Paste new bids from Sheets" })).toHaveCount(0);
});
test("screenshot paste is visibly blocked while a bid is waiting for client review", async ({ page }) => {
  let uploadRequests = 0;
  await page.route("**/storage/v1/object/private-files/**", (route) => { uploadRequests += 1; return route.fulfill({ status: 200, body: "stored" }); });
  await page.goto("http://127.0.0.1:3001/bids?paste-screenshot");
  const target = page.locator('[data-grid-r="0"][data-field="screenshot"] [aria-label^="Screenshot paste target"]');
  await target.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" }));
    element.focus();
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  });
  await expect(page.getByRole("alert")).toContainText("Client approval is required");
  expect(uploadRequests).toBe(0);
});
test("a lost import response freezes the reviewed batch for retry", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/bids?lost-import");
  await page.getByRole("button", { name: "Paste from Sheets", exact: true }).click();
  await page.getByLabel("Import bidder", { exact: true }).selectOption("bidder-0");
  await page.getByLabel("Import resume", { exact: true }).selectOption("resume-0");
  await page.getByLabel("Copied Google Sheets cells").fill("Acme\tEngineer\thttps://example.com/one");
  await page.getByRole("button", { name: "Read columns" }).click();
  await page.getByRole("button", { name: "Preview bids" }).click();
  await expect(page.getByText("Validating profile restrictions")).toHaveCount(0);
  await page.getByRole("button", { name: "Import 1 allowed bids", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same import", exact: true }).first()).toBeEnabled();
  await expect(page.getByLabel("Row 1 Company", { exact: true })).toHaveText("Acme");
});

test("Sheets import stays available when every row is blocked and explains the result", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids?block-import");
  await page.getByRole("button", { name: "Paste from Sheets", exact: true }).click();
  await page.getByLabel("Import bidder", { exact: true }).selectOption("bidder-0");
  await page.getByLabel("Import resume", { exact: true }).selectOption("resume-0");
  await page.getByLabel("Copied Google Sheets cells").fill("Acme\tEngineer\thttps://example.com/one");
  await page.getByRole("button", { name: "Read columns" }).click();
  await page.getByRole("button", { name: "Preview bids" }).click();
  const importButton = page.getByRole("button", { name: "Import 0 allowed bids", exact: true });
  await expect(importButton).toBeEnabled();
  await importButton.click();
  await expect(page.getByRole("alert")).toContainText("No bids to add");
});
test("inline conflict preserves the draft and requires review before retry", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids");
  const company = page.locator('[data-grid-r="0"][data-field="company"]');
  await company.dblclick();
  const editor = page.getByRole("textbox", {
    name: "Edit company",
    exact: true,
  });
  await expect(editor).toBeFocused();
  await editor.fill("My draft");
  await page.evaluate(async () => {
    const path = "/actions.ts";
    const action = await import(path);
    await action.updateBidCell("bid-0", "company", "Another edit", 0);
  });
  await editor.press("Enter");
  await expect(
    page.getByText("Latest: Another edit", { exact: true }),
  ).toBeVisible();
  await expect(editor).toHaveValue("My draft");
  await page
    .getByRole("button", {
      name: "Use latest version and keep draft",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(company).toContainText("My draft");
});
test("tabular paste on the selected grid opens creation without overwriting", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids");
  const cell = page.locator('[data-grid-r="0"][data-field="company"]');
  await cell.click();
  await cell.evaluate((el) => {
    const data = new DataTransfer();
    data.setData(
      "text/plain",
      "New Company\tNew Role\thttps://example.com/new",
    );
    el.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, clipboardData: data }),
    );
  });
  await expect(
    page.getByRole("heading", {
      name: "Paste new bids from Sheets",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Copied Google Sheets cells")).toHaveValue(
    "New Company\tNew Role\thttps://example.com/new",
  );
  await page.keyboard.press("Escape");
  await expect(cell).toHaveText("Linear");
});
test("keyboard focus initializes grid navigation without a mouse", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids");
  const company = page.locator('[data-grid-r="0"][data-field="company"]');
  const role = page.locator('[data-grid-r="0"][data-field="role_name"]');
  await company.focus();
  await expect(company).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(role).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(company).toBeFocused();
  await page.keyboard.press("F2");
  await expect(
    page.getByRole("textbox", { name: "Edit company", exact: true }),
  ).toBeFocused();
});
test("removing the last page clamps pagination and selection", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/bids");
  await page.getByLabel("Found period").selectOption("all");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("11\u201312 of 12 bids")).toBeVisible();
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .last()
    .click();
  await expect(page.getByText("11\u201311 of 11 bids")).toBeVisible();
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .last()
    .click();
  await expect(page.getByText("1\u201310 of 10 bids")).toBeVisible();
});
test("selection clears when edited rows leave the filter", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/bids");
  await page.getByLabel("Found period").selectOption("all");
  await page
    .getByRole("textbox", { name: "Search bids", exact: true })
    .fill("Engineer");
  const cell = page.locator('[data-field="role_name"]').last();
  await cell.dblclick();
  const editor = page.getByRole("textbox", {
    name: "Edit role_name",
    exact: true,
  });
  await editor.fill("Director");
  await editor.press("Enter");
  await expect(
    page.locator('[role="gridcell"][aria-selected="true"]'),
  ).toHaveCount(0);
});
