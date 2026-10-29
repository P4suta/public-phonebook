import { defineConfig, devices } from "@playwright/test";

const configuration = defineConfig({
  testDir: "tests/e2e",
  testIgnore: "**/national*.spec.ts",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  timeout: 30_000,
  globalTimeout: 600_000,
  outputDir: "test-results/fixtures",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/fixtures", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:3100",
    headless: true,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    video: "on",
    trace: "on",
    screenshot: "on",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "android", use: { ...devices["Pixel 7"] } },
    { name: "iphone", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: "cargo run --locked -p public-phonebook --example e2e-fixture",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGINT", timeout: 5_000 },
    timeout: 120_000,
  },
});

export default configuration;
