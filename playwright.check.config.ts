import { defineConfig, devices } from "@playwright/test";

const browserWorkers = 2;
const fixtureOrigin = "http://127.0.0.1:8790";
const serverTimeoutMs = 120000;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: /(?:design|external-links)\.spec\.ts/,
  forbidOnly: true,
  retries: 0,
  workers: browserWorkers,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/check-browser.json" }],
  ],
  outputDir: "test-results/check-browser",
  use: {
    baseURL: fixtureOrigin,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run preview -- --port 8790",
    url: `${fixtureOrigin}/api`,
    env: { DIAL_LOCAL_STATE: ".local/check-state" },
    reuseExistingServer: false,
    timeout: serverTimeoutMs,
  },
});
