import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { useNotificationResource } from "@/lib/use-notifications";
import { notificationResource } from "@/lib/notification-store";
import type { NotificationResult } from "@/lib/notification-types";
const load = async () => ({ data: "browser response" });
function Notice({ initial }: { initial: NotificationResult<string> }) {
  const result = useNotificationResource("same-account:notice", load, initial);
  return createElement("output", null, result.error ?? result.data);
}
afterEach(() => vi.unstubAllGlobals());
it("renders each server request's current data and authorization error without reusing a previous request", () => {
  expect(
    renderToString(
      createElement(Notice, { initial: { data: "first publication" } }),
    ),
  ).toContain("first publication");
  expect(
    renderToString(
      createElement(Notice, { initial: { data: "updated publication" } }),
    ),
  ).toContain("updated publication");
  const unavailable = renderToString(
    createElement(Notice, { initial: { error: "Access denied" } }),
  );
  expect(unavailable).toContain("Access denied");
  expect(unavailable).not.toContain("publication");
  expect(
    notificationResource("server-isolation", load, { data: "new" }),
  ).not.toBe(notificationResource("server-isolation", load, { data: "newer" }));
});
it("uses current props for the hydration server snapshot even when a browser resource already exists", () => {
  vi.stubGlobal("window", new EventTarget());
  notificationResource("same-account:notice", load, {
    data: "old cached publication",
  });
  expect(
    renderToString(
      createElement(Notice, { initial: { data: "server publication" } }),
    ),
  ).toContain("server publication");
  expect(
    renderToString(
      createElement(Notice, { initial: { error: "Access denied" } }),
    ),
  ).toContain("Access denied");
});
