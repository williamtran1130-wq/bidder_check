import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("imports benchmark helpers and runner without environment reads, file writes or hosted setup", () => {
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    globalThis.fetch = () => { throw new Error("Hosted fetch forbidden during import"); };
    process.argv = ["node", "import-probe.mjs", "--staging-ready", "--representative-bids", "12000"];
    Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://kdmvludtvhuuewmhurpw.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fake-public", SUPABASE_SECRET_KEY: "fake-secret" });
    process.env = new Proxy(process.env, {
      get(target, key) {
        if (["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"].includes(String(key))) throw new Error("Staging environment read forbidden during import");
        return Reflect.get(target, key);
      },
    });
    const fs = (await import("node:fs/promises")).default;
    for (const name of ["open", "mkdir", "rename", "writeFile"]) fs[name] = () => { throw new Error("File write forbidden during import"); };
    (await import("node:module")).syncBuiltinESMExports();
    await import("./scripts/screenshot-size-staging-benchmark.mjs");
    const { createBenchmarkRunner } = await import("./scripts/screenshot-size-benchmark-runner.mjs");
    const { fixture, expected, validateReceipt } = await import("./scripts/screenshot-size-benchmark-helpers.mjs");
    if (![createBenchmarkRunner, fixture, expected, validateReceipt].every(value => typeof value === "function")) throw new Error("Missing exported behavior");
    console.log("import-safe");
  `,
    ],
    { env: { NODE_ENV: "test" }, encoding: "utf8" },
  );
  expect(probe.status, probe.stderr).toBe(0);
  expect(probe.stdout.trim()).toBe("import-safe");
});
