import { defineConfig, devices } from "@playwright/test";

const browserWorkers = 2;
const fixtureOrigin = "https://127.0.0.1:8790";
const serverTimeoutMs = 120000;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch:
    /\/(?:contact-design|csp|design|external-links|information|privacy|local-search|search|search-index-api|search-trigger|site-icons|startup)\.spec\.ts$/,
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
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run preview -- --port 8790",
    url: `${fixtureOrigin}/api/datasets`,
    env: { DIAL_LOCAL_STATE: ".local/check-state" },
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: serverTimeoutMs,
  },
});
