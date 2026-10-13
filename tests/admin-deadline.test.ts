import { afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: fake.create }));
import { adminClient } from "@/lib/admin";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fake.create.mockReset();
});
it("preserves a caller's abort signal instead of replacing it with the request timeout", async () => {
  vi.stubEnv("SUPABASE_SECRET_KEY", "test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init: RequestInit) => ({
      aborted: init.signal?.aborted,
    })),
  );
  adminClient(true);
  const request = new AbortController();
  request.abort();
  const bounded = fake.create.mock.calls[0][2].global.fetch;
  await bounded("https://test.invalid", { signal: request.signal });
  expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
});
it("caps the HTTP request to the shared remaining deadline and cancels the real fetch", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubEnv("SUPABASE_SECRET_KEY", "test");
  let aborted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_input: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal?.reason);
          });
        }),
    ),
  );
  adminClient({ deadlineAt: 2000 });
  const bounded = fake.create.mock.calls[0][2].global.fetch;
  const outcome = bounded("https://test.invalid").catch(() => null);
  await vi.advanceTimersByTimeAsync(2001);
  expect(aborted).toBe(true);
  await outcome;
});

it("retains the existing fifteen-second request ceiling when the shared budget is longer", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubEnv("SUPABASE_SECRET_KEY", "test");
  let aborted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_input: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal?.reason);
          }),
        ),
    ),
  );
  adminClient({ deadlineAt: 50000 });
  const outcome = fake.create.mock.calls[0][2].global
    .fetch("https://test.invalid")
    .catch(() => null);
  await vi.advanceTimersByTimeAsync(14999);
  expect(aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(2);
  expect(aborted).toBe(true);
  await outcome;
});

it("keeps the remaining request deadline active while the response body is still arriving", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubEnv("SUPABASE_SECRET_KEY", "test");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (_input: unknown, init: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener("abort", () =>
                controller.error(init.signal?.reason),
              );
            },
          }),
        ),
    ),
  );
  adminClient({ deadlineAt: 2000 });
  const response = await fake.create.mock.calls[0][2].global.fetch(
    "https://test.invalid",
  );
  let bodyStopped = false;
  const body = response.json().catch(() => {
    bodyStopped = true;
  });
  await vi.advanceTimersByTimeAsync(2001);
  expect(bodyStopped).toBe(true);
  await body;
});
