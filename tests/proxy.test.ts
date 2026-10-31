import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const { session } = vi.hoisted(() => ({ session: vi.fn(() => new Response("session-gated")) }));
vi.mock("@/lib/middleware", () => ({ updateSession: session }));
import { proxy } from "@/proxy";
beforeEach(() => session.mockClear());
it.each(["/api/cron/notifications", "/api/cron/storage-cleanup", "/push-worker.js", "/manifest.webmanifest", "/api/reports/overview", "/api/mail-insights/status"])(
  "allows %s to use its own authorization or public asset behavior", async (path) => {
    const response = await proxy(new NextRequest(`https://example.test${path}`));
    expect(session).not.toHaveBeenCalled();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  },
);
it("retains session checks for workspace routes", () => {
  proxy(new NextRequest("https://example.test/notifications"));
  expect(session).toHaveBeenCalledOnce();
});
