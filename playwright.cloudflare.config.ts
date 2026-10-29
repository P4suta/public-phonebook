import { defineConfig, devices } from "@playwright/test";

const configuration = defineConfig({
  testDir: "tests/cloudflare",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  globalTimeout: 600_000,
  outputDir: "test-results/cloudflare",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/cloudflare", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:8787",
    headless: true,
    locale: "ja-JP",
    video: "on",
    trace: "on",
    screenshot: "on",
  },
  projects: [
    { name: "cloudflare-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "cloudflare-iphone", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: "npm run dev:cloudflare",
    url: "http://127.0.0.1:8787/healthz",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGINT", timeout: 10_000 },
    timeout: 540_000,
  },
});

export default configuration;
