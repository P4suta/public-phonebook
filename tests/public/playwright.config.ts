import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { environments } from "../../src/core/environment.ts";

const origin = process.env.DIAL_PUBLIC_ORIGIN;
if (
  origin !== environments.staging.origin &&
  origin !== environments.production.origin
)
  throw new Error(
    "Public verification requires an exact configured HTTPS origin",
  );
const environment =
  origin === environments.staging.origin ? "staging" : "production";
const proxy = process.env.HTTPS_PROXY;
export default defineConfig({
  testDir: ".",
  forbidOnly: true,
  retries: 0,
  workers: 2,
  maxFailures: 1,
  timeout: 60000,
  reporter: [
    ["list"],
    [
      "json",
      { outputFile: resolve(`test-results/public-${environment}.json`) },
    ],
  ],
  outputDir: resolve(`test-results/public-${environment}`),
  use: {
    baseURL: origin,
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
