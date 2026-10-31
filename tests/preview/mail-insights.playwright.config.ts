import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "../../e2e", testMatch: ["mail-insights.spec.ts", "mail-metrics.spec.ts"], outputDir: "../../test-results/mail-insights", workers: 1,
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:3001", reducedMotion: "reduce" },
  webServer: { command: "node node_modules/vite/bin/vite.js --config tests/preview/vite.config.ts --port 3001", cwd: "../..", url: "http://127.0.0.1:3001", reuseExistingServer: true },
});
