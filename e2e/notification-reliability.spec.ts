import { test, expect } from "@playwright/test";
test("same-account authorization changes discard foreign rows and reset the composer", async ({
  page,
}) => {
  await page.route("**/*notification-actions*", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    body = body.replace(
      /(async function getNotificationPage\([^)]*\)\s*\{)/,
      "$1 if(window.__notificationDemoted) return {error:'Access denied'};",
    );
    await route.fulfill({ response, body });
  });
  await page.route("**/main.tsx*", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    const index = body.indexOf("createRoot(document.getElementById");
    if (index < 0) throw new Error("Preview root marker missing");
    body =
      body.slice(0, index) +
      `
function NotificationScopeProbe(){
 const [demoted,setDemoted]=React.useState(false);
 const data={...fixture,profile:{...fixture.profile,role:demoted?'client':'admin'},workspaces:demoted?[{...fixture.workspaces[0],id:'own-workspace',name:'Own workspace'}]:fixture.workspaces};
 const seededMessages=[{id:'old-initial',workspace_id:fixture.workspaces[0].id,title:'Seeded foreign',body:'Old request data',status:'paused',created_at:'2026-01-01T00:00:00Z',next_at:null,recipient_mode:'all',recipient_ids:[],schedule_kind:'daily',local_time:'09:00',weekdays:[]}];
 return React.createElement(React.Fragment,null,React.createElement('button',{onClick:()=>{window.__notificationDemoted=true;setDemoted(true);}},'Demote same account'),React.createElement('button',{onClick:()=>setDemoted(false)},'Restore old scope'),React.createElement(Notifications,{data,initialInbox:[],initialMessages:seededMessages}));
}
createRoot(document.getElementById('root')).render(React.createElement(Providers,null,React.createElement(NotificationScopeProbe)));`;
    await route.fulfill({ response, body });
  });
  await page.goto(
    "http://127.0.0.1:3001/admin-notifications?notification-case=paused",
  );
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Daily reminder",
  );
  await page
    .getByRole("button", { name: "Demote same account", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh messages", exact: true })
    .click();
  await expect(page.getByText("Access denied", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Daily reminder", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Send now", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Seeded foreign", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Restore old scope", exact: true })
    .click();
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await expect(page.getByText("Access denied", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Daily reminder", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Seeded foreign", exact: true }),
  ).toHaveCount(0);
});
test("a disconnected save preserves the composer and never resubmits automatically", async ({
  page,
}) => {
  await page.goto(
    "http://127.0.0.1:3001/notifications?notification-case=save-throw",
  );
  await page.evaluate(() =>
    window.addEventListener("fixture-notification-transport-attempt", () => {
      document.body.dataset.saveAttempts = String(
        Number(document.body.dataset.saveAttempts ?? 0) + 1,
      );
    }),
  );
  await page.getByLabel("Title", { exact: true }).fill("Uncertain save title");
  await page.getByLabel("Message", { exact: true }).fill("Uncertain save body");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(
    page.getByText("Could not confirm save. Check schedules before retrying."),
  ).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Uncertain save title",
  );
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Uncertain save body",
  );
  await expect(page.locator("body")).toHaveAttribute("data-save-attempts", "1");
});
test("refresh updates a deep-linked notification beyond the displayed page", async ({
  page,
}) => {
  await page.goto(
    "http://127.0.0.1:3001/admin-notifications?notification-case=paged&notification=notice-124",
  );
  const notice = page.locator("#notification-notice-124");
  await expect(
    notice.getByRole("button", { name: "Mark read", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("fixture-notification-resolve", { detail: "notice-124" }),
    ),
  );
  await page
    .getByRole("button", { name: "Refresh inbox", exact: true })
    .click();
  await expect(
    notice.getByRole("button", { name: "Mark unread", exact: true }),
  ).toBeDisabled();
});
test("device push state reflects the registered account and can be disabled", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Notification", {
      value: { permission: "granted" },
    });
    Object.defineProperty(window, "PushManager", { value: {} });
    Object.defineProperty(navigator, "serviceWorker", {
      value: {
        getRegistration: async () => ({
          pushManager: {
            getSubscription: async () => ({
              endpoint: "https://push.test.invalid/device",
              unsubscribe: async () => {
                document.body.dataset.unsubscribed = "yes";
                return true;
              },
            }),
          },
        }),
      },
    });
  });
  await page.goto(
    "http://127.0.0.1:3001/admin-notifications?notification-case=device-enabled",
  );
  await expect(
    page.getByText("Browser notifications: enabled on this device."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(
    page.getByText("Browser notifications: off on this device."),
  ).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute(
    "data-unsubscribed",
    "yes",
  );
});
test("blocked browser permission is explicit while the inbox remains available", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Notification", {
      value: { permission: "denied" },
    });
    Object.defineProperty(window, "PushManager", { value: {} });
    Object.defineProperty(navigator, "serviceWorker", { value: {} });
  });
  await page.goto("http://127.0.0.1:3001/admin-notifications");
  await expect(
    page.getByText("Browser notifications: blocked by browser permission."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Enable on this device", exact: true })
    .click();
  await expect(
    page.getByText(
      "Notifications are blocked in this browser. Allow them in browser settings to enable push.",
    ),
  ).toBeVisible();
  await expect(page.getByText("All caught up", { exact: true })).toBeVisible();
});
test("a failed save preserves the authored title and body", async ({
  page,
}) => {
  await page.goto(
    "http://127.0.0.1:3001/notifications?notification-case=save-error",
  );
  await page.getByLabel("Title", { exact: true }).fill("Do not lose my title");
  await page
    .getByLabel("Message", { exact: true })
    .fill("Do not lose my message");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(
    page.getByText("Notifications are unavailable. Please retry.").first(),
  ).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Do not lose my title",
  );
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Do not lose my message",
  );
});
test("deep links beyond page one open and the unread count covers every page", async ({
  page,
}) => {
  await page.goto(
    "http://127.0.0.1:3001/admin-notifications?notification-case=paged&notification=notice-124",
  );
  await expect(
    page.getByRole("heading", { name: "Update 124", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inbox (125)", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Update 50", exact: true }),
  ).toBeVisible();
});
test("now sends without a date; recurring scheduling is explicit and preserves composer during refresh", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001/notifications");
  await page.getByLabel("Title", { exact: true }).fill("Reminder");
  await page
    .getByLabel("Message", { exact: true })
    .fill("Keep this authored message");
  await expect(page.getByLabel("Delivery", { exact: true })).toHaveValue("now");
  await expect(page.getByLabel("Send at (Central Time)")).toHaveCount(0);
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(
    page.getByText("Message queued for inbox publication"),
  ).toBeVisible();
  await page.getByLabel("Delivery", { exact: true }).selectOption("daily");
  await expect(page.getByLabel("Central time")).toHaveValue("09:00");
  await expect(
    page.getByRole("button", { name: "Schedule", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Title", { exact: true }).fill("Unsaved title");
  await page.getByRole("button", { name: "Refresh messages" }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Unsaved title",
  );
});
test("unavailable schedules offer retry rather than an empty success", async ({
  page,
}) => {
  await page.goto(
    "http://127.0.0.1:3001/notifications?notification-case=unavailable",
  );
  await expect(
    page.getByText("Notifications are unavailable. Please retry.").first(),
  ).toBeVisible();
  await expect(page.getByText("No messages in this view.")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }).first(),
  ).toBeVisible();
});
test("paused edits retain their delivery settings and explicit resume", async ({
  page,
}) => {
  await page.goto(
    "http://127.0.0.1:3001/notifications?notification-case=paused",
  );
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Central time")).toHaveValue("10:15");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
});
