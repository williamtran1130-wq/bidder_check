import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir:
    "../../.superpowers/sdd/2026-10-13-feature-preserving-improvements/task8-compat-suite",
  testMatch: "*.spec.ts",
  outputDir:
    "../../.superpowers/sdd/2026-10-13-feature-preserving-improvements/task8-fix1-compat-output",
  workers: 1,
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:3102" },
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js --config tests/preview/vite.config.ts --port 3102",
    cwd: "../..",
    url: "http://127.0.0.1:3102",
    reuseExistingServer: true,
  },
});
