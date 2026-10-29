import { defineConfig, devices } from "@playwright/test";
process.env.EGRESS_PREVIEW_ORIGIN = "http://127.0.0.1:3116";
export default defineConfig({
  testDir: "../../e2e",
  testMatch: ["egress.spec.ts", "screenshot-retention.spec.ts"],
  outputDir: "../../test-results/egress-browser",
  workers: 2,
  retries: 0,
  use: { trace: "off", screenshot: "off" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  webServer: {
    command: "node node_modules/vite/bin/vite.js --config tests/preview/vite.config.ts --port 3116 --strictPort",
    cwd: "../..",
    url: "http://127.0.0.1:3116/egress.html",
    reuseExistingServer: !process.env.CI,
  },
});
