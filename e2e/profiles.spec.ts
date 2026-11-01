import { test, expect } from "@playwright/test";

test("clients manage shared candidate details separately from bidder assignments", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/profiles");
  await expect(
    page.getByRole("heading", { name: "Shared candidate profiles." }),
  ).toBeVisible();
  await expect(page.getByText("ENG-01", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /ENG-01/ }).click();
  const details = page.getByRole("dialog");
  await expect(details.getByText("Chicago, IL", { exact: true })).toBeVisible();
  await expect(details.getByText(/Focus on remote roles/)).toBeVisible();
  await expect(details.getByRole("heading", { name: "Jamie Parker" })).toBeVisible();
  await expect(details.getByText("bidder0@example.test", { exact: true })).toBeVisible();
  await expect(details.getByText("+1 (555) 010-2000", { exact: true })).toBeVisible();
});

test("assignment success clears the saved ID and removal clears the native picker", async ({ page }) => {
  await page.route("https://upload.example.test/**", route => route.fulfill({ status: 200, body: "{}" }));
  await page.goto("http://127.0.0.1:3001/resumes?assignment-upload");
  await page.getByRole("button", { name: "Assign profile", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Candidate profile").selectOption("profile-bidder-0");
  await dialog.getByLabel("Email address").fill("resume@example.test");
  await dialog.getByLabel("Phone number").fill("555-0100");
  const picker = dialog.getByLabel("Choose resume file");
  await picker.setInputFiles({ name: "resume.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF fixture") });
  await dialog.getByRole("button", { name: "Assign profile and upload PDF" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Assign profile", exact: true }).click();
  await expect(dialog.locator('input[name="id"]')).toHaveValue("");
  await picker.setInputFiles({ name: "resume.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF fixture") });
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  expect(await picker.evaluate((input: HTMLInputElement) => input.files?.length)).toBe(0);
});

test("editing an assignment with bid history keeps its locked IDs in the save payload", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/resumes?assignment-upload");
  await page.getByRole("button", { name: /Jamie Parker/ }).click();
  const details = page.getByRole("dialog");
  await details.getByRole("button", { name: "Edit assignment" }).click();
  const editor = page.getByRole("dialog").last();
  await expect(editor.getByText(/locked because this assignment has bid history/i)).toBeVisible();
  await expect(editor.getByLabel("Assigned bidder")).toHaveCount(0);
  await expect(editor.getByLabel("Candidate profile")).toHaveCount(0);
  await expect(editor.locator('input[name="bidder_id"]')).toHaveValue("bidder-0");
  await expect(editor.locator('input[name="profile_id"]')).toHaveValue("profile-bidder-0");
  await editor.getByLabel("Email address").fill("updated@example.test");
  await page.evaluate(() => {
    document.body.dataset.assignmentPayload = "";
    window.addEventListener("assignment-save", (event) => {
      document.body.dataset.assignmentPayload = JSON.stringify((event as CustomEvent).detail);
    }, { once: true });
  });
  await editor.getByRole("button", { name: "Save assignment" }).click();
  await expect.poll(() => page.locator("body").getAttribute("data-assignment-payload")).toContain('"profileId":"profile-bidder-0"');
  await expect(page.locator("body")).toHaveAttribute("data-assignment-payload", /"bidderId":"bidder-0"/);
  await expect(page.locator("body")).toHaveAttribute("data-assignment-payload", /"email":"updated@example.test"/);
});

test("changing an assignment bidder requires a PDF for the new owner", async ({ page }) => {
  await page.route("https://upload.example.test/**", route => route.fulfill({ status: 200, body: "{}" }));
  await page.goto("http://127.0.0.1:3001/resumes?assignment-upload");
  await page.getByRole("button", { name: /Taylor Reed/ }).click();
  const details = page.getByRole("dialog");
  await details.getByRole("button", { name: "Edit assignment" }).click();
  const editor = page.getByRole("dialog").last();
  await editor.getByLabel("Assigned bidder").selectOption("bidder-2");
  await editor.getByLabel("Candidate profile").selectOption("profile-bidder-2");
  await expect(editor.getByText(/clears the previous bidder’s PDF/i)).toBeVisible();
  await expect(editor.getByLabel("Choose resume file")).toHaveAttribute("required", "");
  await editor.getByLabel("Email address").fill("new-owner@example.test");
  await editor.getByLabel("Phone number").fill("555-0199");
  await editor.getByLabel("Choose resume file").setInputFiles({ name: "new-owner.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF fixture") });
  await page.evaluate(() => {
    document.body.dataset.assignmentPayload = "";
    window.addEventListener("assignment-save", (event) => {
      document.body.dataset.assignmentPayload = JSON.stringify((event as CustomEvent).detail);
    }, { once: true });
  });
  await editor.getByRole("button", { name: "Assign profile and upload PDF" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.locator("body")).toHaveAttribute("data-assignment-payload", /"bidderId":"bidder-2"/);
});

test("invalid resume files are rejected before creating an assignment", async ({ page }) => {
  await page.goto("http://127.0.0.1:3001/resumes?assignment-upload");
  await page.evaluate(() => { document.body.dataset.saves = "0"; window.addEventListener("assignment-save", () => { document.body.dataset.saves = String(Number(document.body.dataset.saves) + 1); }); });
  await page.getByRole("button", { name: "Assign profile", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Candidate profile").selectOption("profile-bidder-0");
  await dialog.getByLabel("Email address").fill("resume@example.test");
  await dialog.getByLabel("Phone number").fill("555-0100");
  await dialog.getByLabel("Choose resume file").setInputFiles({ name: "resume.png", mimeType: "image/png", buffer: Buffer.from("invalid") });
  await dialog.getByRole("button", { name: "Assign profile and upload PDF" }).click();
  await expect(dialog.getByRole("alert")).toContainText("file type");
  await expect(page.locator("body")).toHaveAttribute("data-saves", "0");
});

test("resume assignments select a shared profile and keep contact details local", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/resumes");
  await page.getByRole("button", { name: "Assign profile", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Candidate profile")).toBeVisible();
  await expect(dialog.getByLabel("Assigned bidder")).toBeVisible();
  await expect(dialog.getByLabel("Email address")).toHaveAttribute(
    "required",
    "",
  );
  await expect(dialog.getByLabel("Phone number")).toHaveAttribute(
    "required",
    "",
  );
  await expect(dialog.getByLabel("Postal address")).toHaveCount(0);
  await expect(dialog.getByLabel("Choose resume file")).toHaveAttribute(
    "accept",
    "application/pdf",
  );
  await expect(dialog.getByLabel("Choose resume file")).toHaveAttribute(
    "required",
    "",
  );
});
