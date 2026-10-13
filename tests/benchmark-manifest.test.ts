import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("checks the current 57-case list acceptance manifest without staging setup", () => {
  const check = spawnSync(
    process.execPath,
    ["scripts/check-benchmark-manifest.mjs"],
    { env: { NODE_ENV: "test" }, encoding: "utf8" },
  );
  expect(check.status, check.stderr).toBe(0);
  expect(JSON.parse(check.stdout)).toEqual({
    cases: 57,
    requests: 1425,
    concurrency: 5,
    p95LimitMs: 10000,
  });
  const manifest = JSON.parse(
    readFileSync("scripts/screenshot-size-benchmark-manifest.json", "utf8"),
  );
  manifest.cases[0].status = "pending_review";
  const directory = mkdtempSync(path.join(tmpdir(), "bidder-check-manifest-"));
  const file = path.join(directory, "manifest.json");
  writeFileSync(file, JSON.stringify(manifest));
  const mismatch = spawnSync(
    process.execPath,
    ["scripts/check-benchmark-manifest.mjs", "--manifest", file],
    { env: { NODE_ENV: "test" }, encoding: "utf8" },
  );
  expect(mismatch.status).toBe(1);
  expect(mismatch.stderr).toMatch(/manifest/i);
  expect(JSON.parse(readFileSync(file, "utf8")).cases[0].status).toBe(
    "pending_review",
  );
});
