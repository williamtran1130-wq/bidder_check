import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "../../e2e",
  outputDir: "../../test-results/workspace-release",
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: "line",
  expect: { timeout: 15000 },
  use: { baseURL: "http://127.0.0.1:3005", reducedMotion: "reduce", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  webServer: [
    { command: "node node_modules/next/dist/bin/next start -p 3005", cwd: "../..", url: "http://127.0.0.1:3005/auth/login", reuseExistingServer: true },
    { command: "node node_modules/vite/bin/vite.js --config tests/preview/vite.config.ts --port 3001", cwd: "../..", url: "http://127.0.0.1:3001", reuseExistingServer: true },
  ],
});
