import { expect, test } from "./fixtures.ts";
import { detailActionName, waitForLocalSearch } from "./search-sources.ts";

test("the page uses local assets and a fresh, server-controlled CSP nonce", async ({
  page,
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The test server URL is required");
  const origin = new URL(baseURL).origin;
  const outside: string[] = [];
  page.on("request", (event) => {
    if (!event.url().startsWith(origin) && !event.url().startsWith("data:"))
      outside.push(event.url());
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await page.getByRole("searchbox").fill("国立国会図書館");
  await expect(page.locator("article").first()).toBeVisible();
  expect(outside).toEqual([]);
  const first = await request.get("/", {
    headers: {
      "x-dial-nonce": "client-supplied",
      Authorization: "Bearer synthetic-test-value",
      Cookie: "synthetic=1",
    },
  });
  const second = await request.get("/");
  const csp = first.headers()["content-security-policy"];
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("worker-src 'self'");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).not.toContain("client-supplied");
  expect(csp).not.toBe(second.headers()["content-security-policy"]);
  expect(first.headers()["cache-control"]).toBe("no-store, no-transform");
  expect(first.headers()["set-cookie"]).toBeUndefined();
});

test("the browser stores public search files and tab positions without recording queries", async ({
  page,
}) => {
  const query = "国立国会図書館";
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await waitForLocalSearch(page);
  await page.getByRole("searchbox").fill(query);
  const result = page.locator("article").first();
  await expect(result).toBeVisible();
  await result.getByRole("link", { name: detailActionName }).click();
  await expect(page).toHaveURL(/\/contacts\/[^/?#]+#from=/u);
  await expect(
    page.getByRole("heading", { level: 1, name: query }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.locator("article").first()).toBeVisible();
  await waitForLocalSearch(page);
  const stored = await page.evaluate(async () => ({
    cookie: document.cookie,
    local: Object.keys(localStorage),
    session: Object.entries(sessionStorage),
    databases: (await indexedDB.databases()).map((database) => database.name),
    workers: (await navigator.serviceWorker.getRegistrations()).length,
    caches: await caches.keys(),
    searchFiles: await (async (): Promise<string[]> => {
      const root = await navigator.storage.getDirectory();
      const parent = await root.getDirectoryHandle("public-phonebook-search");
      const names = new Set<string>();
      for await (const directory of parent.values()) {
        if (directory.kind !== "directory")
          throw new Error(
            "Unexpected search file outside a temporary directory",
          );
        for await (const name of directory.keys()) names.add(name);
      }
      return [...names].sort();
    })(),
  }));
  expect(stored.cookie).toBe("");
  expect(stored.local).toEqual([]);
  expect(stored.databases).toEqual([]);
  expect(stored.workers).toBe(0);
  expect(stored.caches).toEqual([]);
  expect(stored.searchFiles).toEqual([
    "folded-names",
    "index",
    "name-offsets",
    "telephone-offsets",
  ]);
  for (const [key, value] of stored.session) {
    expect(key).toMatch(/^tsr-scroll-restoration/u);
    for (const form of [query, encodeURIComponent(query)])
      expect(value).not.toContain(form);
  }
});
