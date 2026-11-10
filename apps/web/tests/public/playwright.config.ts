import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { probeWindowMs } from "../../../../tools/probe-budget.ts";
import {
  admittedOrigin,
  rehearsalRequested,
} from "../../../../tools/public-request.ts";

// `probeHold` proves that the budget holds a request for at most one probe window, and a page settles after its document, its scripts, and its data.
const settleTimeoutMs = 3 * probeWindowMs;
const testTimeoutMs = 6 * settleTimeoutMs;
const origin = process.env.DIAL_PUBLIC_ORIGIN ?? "";
if (!admittedOrigin(origin, rehearsalRequested()))
  throw new Error(
    "Public verification requires an exact configured HTTPS origin",
  );
const proxy = process.env.HTTPS_PROXY;
export default defineConfig({
  testDir: ".",
  forbidOnly: true,
  retries: 0,
  workers: 2,
  maxFailures: 1,
  timeout: testTimeoutMs,
  expect: { timeout: settleTimeoutMs },
  reporter: [
    ["list"],
    ["json", { outputFile: resolve("test-results/public-production.json") }],
  ],
  outputDir: resolve("test-results/public-production"),
  use: {
    baseURL: origin,
    actionTimeout: settleTimeoutMs,
    navigationTimeout: settleTimeoutMs,
    ...(proxy ? { proxy: { server: proxy } } : {}),
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /api\.spec\.ts/u,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      testIgnore: /api\.spec\.ts/u,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testIgnore: /api\.spec\.ts/u,
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "mobile",
      testIgnore: /api\.spec\.ts/u,
      use: { ...devices["iPhone 13"] },
    },
    { name: "api", testMatch: /api\.spec\.ts/u },
  ],
});
