import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("screenshot preview uses the latest inline application location with no history API", async ({
  page,
}, info) => {
  await page.route("https://images.example.test/proof.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: readFileSync(
        new URL("../tests/fixtures/screenshot-size-proof.png", import.meta.url),
      ),
    }),
  );
  await page.goto("http://127.0.0.1:3001/bids?screenshot-sizes&upload-context");
  await page.getByLabel("Found period", { exact: true }).selectOption("all");
  const trigger = page.getByRole("button", {
    name: "Open screenshot for Linear",
    exact: true,
  });
  await trigger.scrollIntoViewIfNeeded();
  if (info.project.name === "mobile") await trigger.tap();
  else {
    await trigger.focus();
    await page.keyboard.press("Enter");
  }
  const details = page.getByRole("region", {
    name: "Application location",
    exact: true,
  });
  await expect(details).toContainText("Latest application location");
  await expect(details).toContainText("Chicago, IL, United States (US)");
  await expect(
    page.getByRole("heading", { name: "Upload history", exact: true }),
  ).toHaveCount(0);
  if (info.project.name !== "mobile") {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await details
      .getByRole("button", { name: "Copy IP address", exact: true })
      .click();
    await expect(details.getByRole("status")).toContainText(
      "IP address copied",
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "203.0.113.10",
    );
  }
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
