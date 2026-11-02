import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: "../../e2e",
  testMatch: /(?:bidder-security-ui|people|account-recovery)\.spec\.ts/,
  outputDir: "../../test-results/bidder-security",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3001" },
  webServer: {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    command:
      "node node_modules/vite/bin/vite.js --config tests/preview/vite.config.ts",
    url: "http://127.0.0.1:3001",
    reuseExistingServer: true,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});
