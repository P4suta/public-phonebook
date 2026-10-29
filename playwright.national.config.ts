import { defineConfig, devices } from "@playwright/test";

const configuration = defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/national*.spec.ts",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  timeout: 90_000,
  globalTimeout: 600_000,
  outputDir: "test-results/national",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/national", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:3101",
    headless: true,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    video: "on",
    trace: "on",
    screenshot: "on",
  },
  projects: [
    {
      name: "national-chromium",
      testMatch: "**/national.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "national-android",
      testMatch: "**/national.spec.ts",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "national-iphone",
      testMatch: "**/national.spec.ts",
      use: { ...devices["iPhone 13"] },
    },
    {
      name: "national-bulk",
      testMatch: "**/national-bulk.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "cargo run --locked -p public-phonebook -- serve --port 3101",
    url: "http://127.0.0.1:3101",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGINT", timeout: 5_000 },
    timeout: 120_000,
  },
});

export default configuration;
