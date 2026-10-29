import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("refuses activation against a different project before creating any remote resources", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/screenshot-retention-production.mjs", "--activate"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: "https://kdmvludtvhuuewmhurpw.supabase.co",
        SUPABASE_SECRET_KEY: "test-not-a-credential",
      },
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Production project required");
});
it("requires an explicit operator mode instead of defaulting to cleanup or activation", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/screenshot-retention-production.mjs"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: "https://aizorlyfggwbewetnwqm.supabase.co",
        SUPABASE_SECRET_KEY: "test-not-a-credential",
      },
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Choose an explicit operator mode");
});
