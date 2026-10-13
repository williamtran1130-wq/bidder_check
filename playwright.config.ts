import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/browser-e2e",
  fullyParallel: true,
  workers: 2,
  expect: { timeout: 15000 },
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    reducedMotion: "reduce",
  },
  webServer: [
    {
      command: "npm run start",
      url: "http://localhost:3000/auth/login",
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
    {
      command: "npx vite --config tests/preview/vite.config.ts",
      url: "http://127.0.0.1:3001",
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
  ],
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});
