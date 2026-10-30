import { defineConfig, devices } from "@playwright/test";

const browserWorkers = 2;
const testOrigin = "http://127.0.0.1:8787";
const serverTimeoutMs = 120000;

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: browserWorkers,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/native", open: "never" }],
    ["json", { outputFile: "test-results/browser.json" }],
  ],
  outputDir: "test-results/browser",
  use: {
    baseURL: testOrigin,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /api\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      testIgnore: /api\.spec\.ts/,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testIgnore: /api\.spec\.ts/,
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "mobile",
      testIgnore: /api\.spec\.ts/,
      use: { ...devices["iPhone 13"] },
    },
    { name: "api", testMatch: /api\.spec\.ts/ },
  ],
  webServer: {
    command: "npm run preview",
    url: `${testOrigin}/api`,
    reuseExistingServer: !process.env.CI,
    timeout: serverTimeoutMs,
  },
});
