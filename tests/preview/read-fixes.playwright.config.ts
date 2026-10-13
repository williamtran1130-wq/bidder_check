import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "../../e2e",
  testMatch: "read-fixes.spec.ts",
  outputDir:
    "../../.superpowers/sdd/2026-10-13-feature-preserving-improvements/task7-fix1-browser-output",
  workers: 1,
  expect: { timeout: 10000 },
  use: { ...devices["Desktop Chrome"] },
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js --config tests/preview/vite.config.ts --port 3102",
    cwd: "../..",
    url: "http://127.0.0.1:3102",
    reuseExistingServer: true,
  },
});
