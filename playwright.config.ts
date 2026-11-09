import { defineConfig, devices } from "@playwright/test";

const browserWorkers = 2;
const testPort = Number(process.env.DIAL_TEST_PORT ?? 8787);
if (!Number.isSafeInteger(testPort) || testPort < 1024 || testPort > 65535)
  throw new Error("DIAL_TEST_PORT must be an unprivileged TCP port");
const testOrigin = `https://127.0.0.1:${testPort}`;
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
    ignoreHTTPSErrors: true,
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
    command: `npm run preview -- --port ${testPort}`,
    url: `${testOrigin}/api/datasets`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: serverTimeoutMs,
  },
});
