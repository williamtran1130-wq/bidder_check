import { existsSync } from "node:fs";
import { expect, it } from "vitest";

const unavailable = { ip: null, city: null, region: null, country: null, source: "unavailable", status: "unavailable" };
// Before the feature exists, exercise the current no-collection behavior.
const capture = existsSync("src/lib/upload-context.ts")
  ? (await import("@/lib/upload-context")).captureUploadContext
  : () => unavailable;
function metadata(values: Record<string, string> = {}) {
  return new Headers({ "x-vercel-forwarded-for": "203.0.113.10", "x-vercel-ip-city": "S%C3%A3o%20Paulo", "x-vercel-ip-country-region": "SP", "x-vercel-ip-country": "BR", ...values });
}
it("captures trusted platform IP and decoded approximate geography", () => {
  expect(capture(metadata(), true)).toEqual({ ip: "203.0.113.10", city: "São Paulo", region: "SP", country: "BR", source: "vercel", status: "available" });
  expect(capture(metadata({ "x-vercel-forwarded-for": "2001:db8::1" }), true).ip).toBe("2001:db8::1");
});
it("ignores forged platform headers outside Vercel and never falls back to forwarding chains", () => {
  expect(capture(metadata(), false)).toEqual(unavailable);
  expect(capture(new Headers({ "x-forwarded-for": "203.0.113.10", "x-real-ip": "203.0.113.10" }), true)).toEqual(unavailable);
  for (const ip of ["", "999.1.1.1", "203.0.113.10, 198.51.100.2", "203.0.113.10:443", "2001:db8::1%eth0", "[2001:db8::1]"]) {
    expect(capture(metadata({ "x-vercel-forwarded-for": ip }), true)).toEqual(unavailable);
  }
});
it("bounds geography, rejects malformed percent encoding and control characters", () => {
  for (const city of ["%ZZ", "%00Chicago", "%09Chicago", "%0AChicago", "Chicago%0D", "%E2%80%AEChicago", "x".repeat(121), "%".repeat(1100)]) {
    expect(capture(metadata({ "x-vercel-ip-city": city }), true).city).toBeNull();
  }
  expect(capture(metadata({ "x-vercel-ip-country-region": "IL-too-long", "x-vercel-ip-country": "USA" }), true)).toMatchObject({ ip: "203.0.113.10", region: null, country: null });
  expect(capture(new Headers({ "x-vercel-forwarded-for": "203.0.113.10" }), true)).toMatchObject({ ip: "203.0.113.10", city: null, region: null, country: null });
});
