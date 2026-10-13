import { expect, it, vi, afterEach } from "vitest";
import { notificationScope } from "@/lib/notification-scope";
import {
  notificationResource,
  discardNotificationScope,
} from "@/lib/notification-store";
const profile = {
  id: "same-user",
  role: "admin",
  approval_status: "approved",
  archived: false,
};
const memberships = [
  { id: "foreign", owner_id: "other" },
  { id: "own", owner_id: "same-user" },
];
afterEach(() => vi.unstubAllGlobals());
it("scopes private notifications by identity, role, account state and canonical memberships", () => {
  const original = notificationScope(profile, memberships);
  expect(notificationScope(profile, [...memberships].reverse())).toBe(original);
  for (const change of [
    { id: "other" },
    { role: "client" },
    { approval_status: "pending" },
    { archived: true },
  ])
    expect(notificationScope({ ...profile, ...change }, memberships)).not.toBe(
      original,
    );
  expect(notificationScope(profile, memberships.slice(1))).not.toBe(original);
  expect(
    notificationScope(profile, [
      { id: "foreign", owner_id: "new-owner" },
      memberships[1],
    ]),
  ).not.toBe(original);
});
it("discards private cached rows and ignores an in-flight old-scope completion", async () => {
  vi.stubGlobal("window", new EventTarget());
  let finish: (value: { data: string }) => void = () => {};
  const before = notificationScope(profile, memberships);
  const old = notificationResource(
    `${before}messages`,
    () =>
      new Promise<{ data: string }>((resolve) => {
        finish = resolve;
      }),
    { data: "foreign private message" },
  );
  const pending = old.refresh();
  discardNotificationScope(before);
  const after = notificationScope(
    { ...profile, role: "client" },
    memberships.slice(1),
  );
  const current = notificationResource(
    `${after}messages`,
    async () => ({ error: "Access denied" }),
    { error: "Access denied" },
  );
  finish({ data: "late private message" });
  await pending;
  expect(old.snapshot().data).toBeUndefined();
  expect(current.snapshot()).toEqual({ error: "Access denied" });
  expect(
    notificationResource(`${before}messages`, async () => ({
      error: "Access denied",
    })).snapshot().data,
  ).toBeUndefined();
});
it("a rejected old-scope request cannot retain its prior private data", async () => {
  vi.stubGlobal("window", new EventTarget());
  let reject: (error: Error) => void = () => {};
  const scope = notificationScope(profile, memberships);
  const resource = notificationResource(
    `${scope}rejected`,
    () =>
      new Promise<{ data: string }>((_resolve, fail) => {
        reject = fail;
      }),
    { data: "old private data" },
  );
  const pending = resource.refresh();
  discardNotificationScope(scope);
  reject(new Error("Access denied"));
  await pending;
  expect(resource.snapshot()).toEqual({});
});
