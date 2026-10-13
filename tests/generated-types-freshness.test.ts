import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("checks executable migration types without replacing stale or missing output", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bidder-check-types-"));
  mkdirSync(path.join(directory, "supabase/migrations"), { recursive: true });
  mkdirSync(path.join(directory, "src/lib"), { recursive: true });
  const output = path.join(directory, "src/lib/database.types.ts");
  writeFileSync(
    path.join(directory, "supabase/migrations/001.sql"),
    "create table public.example(id uuid primary key, count integer, enabled boolean); create function public.example_count() returns integer language sql as $$ select 1 $$;",
  );
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [path.resolve("scripts/generate-types.mjs"), ...args],
      { cwd: directory, env: { NODE_ENV: "test" }, encoding: "utf8" },
    );
  const missing = run("--check");
  expect(missing.status, missing.stderr).toBe(1);
  expect(missing.stderr).toMatch(/missing|stale/i);
  const generate = run();
  expect(generate.status, generate.stderr).toBe(0);
  const generated = readFileSync(output, "utf8");
  expect(generated).toContain("count: number | null");
  expect(generated).toContain("example_count:");
  const fresh = run("--check");
  expect(fresh.status, fresh.stderr).toBe(0);
  expect(readFileSync(output, "utf8")).toBe(generated);
  writeFileSync(output, "stale types\n");
  const stale = run("--check");
  expect(stale.status, stale.stderr).toBe(1);
  expect(stale.stderr).toMatch(/stale/i);
  expect(readFileSync(output, "utf8")).toBe("stale types\n");
});
