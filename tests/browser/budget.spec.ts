import { expect, test } from "./fixtures.ts";
import { saveData } from "./search-sources.ts";

const bytesPerKibibyte = 1024;
// The search page's own scripts, before the search index or its Worker loads.
const scriptBudget = {
  transferred: 232 * bytesPerKibibyte,
  decoded: 736 * bytesPerKibibyte,
} as const;

test("the search page loads its scripts within the budget before the index", async ({
  page,
  baseURL,
}, info) => {
  if (!baseURL) throw new Error("The test server URL is required");
  await saveData(page);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const scripts = await page.evaluate(
    (origin) =>
      performance
        .getEntriesByType("resource")
        .filter(
          (entry): entry is PerformanceResourceTiming =>
            entry instanceof PerformanceResourceTiming &&
            entry.name.startsWith(origin) &&
            new URL(entry.name).pathname.endsWith(".js"),
        )
        .map((entry) => ({
          path: new URL(entry.name).pathname,
          transferred: entry.encodedBodySize,
          decoded: entry.decodedBodySize,
        })),
    new URL(baseURL).origin,
  );
  const transferred = scripts.reduce((sum, item) => sum + item.transferred, 0);
  const decoded = scripts.reduce((sum, item) => sum + item.decoded, 0);
  await info.attach("search-page-scripts", {
    body: JSON.stringify({ transferred, decoded, scripts }, null, 2),
    contentType: "application/json",
  });
  expect(scripts.length).toBeGreaterThan(0);
  expect(
    scripts.some((item) => item.path.includes("local-search-worker")),
  ).toBe(false);
  expect(transferred).toBeLessThanOrEqual(scriptBudget.transferred);
  expect(decoded).toBeLessThanOrEqual(scriptBudget.decoded);
});
