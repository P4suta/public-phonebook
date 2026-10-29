import { defineConfig, devices } from "@playwright/test";

const configuration = defineConfig({
  testDir: "tests",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  globalTimeout: 600_000,
  outputDir: "test-results/production",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/production", open: "never" }],
  ],
  use: {
    baseURL: "https://dial.page",
    headless: true,
    locale: "ja-JP",
    video: "on",
    trace: "on",
    screenshot: "on",
  },
  projects: [
    {
      name: "production-chromium",
      testMatch: "**/cloudflare/*.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "production-iphone",
      testMatch: "**/cloudflare/*.spec.ts",
      use: { ...devices["iPhone 13"] },
    },
    {
      name: "production-bulk",
      testMatch: "**/e2e/national-bulk.spec.ts",
      dependencies: ["production-chromium", "production-iphone"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

export default configuration;
