import { defineConfig } from "vitest/config";

const testWorkers = 2;
const testTimeoutMs = 15000;
const fixtureTimeoutMs = 30000;

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    maxWorkers: testWorkers,
    testTimeout: testTimeoutMs,
    hookTimeout: fixtureTimeoutMs,
    reporters: ["default", "json"],
    outputFile: { json: "test-results/unit.json" },
  },
});
