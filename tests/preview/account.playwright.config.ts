import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
export default defineConfig({
  testDir: "../../e2e",
  outputDir:
    "../../.superpowers/sdd/2026-10-13-feature-preserving-improvements/account-browser-output",
  testMatch: "account-recovery.spec.ts",
  workers: 1,
  use: { ...devices["Desktop Chrome"] },
  webServer: {
    cwd: root,
    command: `"${root}node_modules/node/bin/node.exe" "${root}node_modules/vite/bin/vite.js" --config tests/preview/vite.config.ts --port 3102`,
    url: "http://127.0.0.1:3102",
    reuseExistingServer: true,
    timeout: 60000,
  },
});
