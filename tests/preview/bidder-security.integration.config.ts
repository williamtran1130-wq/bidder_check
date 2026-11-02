import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
const enabled = process.env.BIDDER_SECURITY_INTEGRATION === "1";
if (enabled) {
  for (const name of [
    "BIDDER_SECURITY_SUPABASE_URL",
    "BIDDER_SECURITY_DATABASE_URL",
  ]) {
    const value = process.env[name];
    if (
      !value ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname)
    )
      throw new Error(
        `${name} must point to an explicitly configured local test instance.`,
      );
  }
  for (const name of [
    "BIDDER_SECURITY_PUBLISHABLE_KEY",
    "BIDDER_SECURITY_SECRET_KEY",
  ])
    if (!process.env[name])
      throw new Error(`${name} is required for local integration tests.`);
}
export default defineConfig({
  testDir: "../../e2e",
  testMatch: "bidder-security.integration.spec.ts",
  outputDir: "../../test-results/bidder-security-integration",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3103" },
  ...(enabled
    ? {
        webServer: {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          command: "node node_modules/next/dist/bin/next dev --port 3103",
          url: "http://127.0.0.1:3103/auth/login",
          reuseExistingServer: false,
          timeout: 120000,
          env: {
            NEXT_PUBLIC_SUPABASE_URL: process.env.BIDDER_SECURITY_SUPABASE_URL!,
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
              process.env.BIDDER_SECURITY_PUBLISHABLE_KEY!,
            SUPABASE_SECRET_KEY: process.env.BIDDER_SECURITY_SECRET_KEY!,
            MANAGED_PASSWORD_HMAC_KEY: "ab".repeat(32),
            APP_URL: "http://127.0.0.1:3103",
          },
        },
      }
    : {}),
});
