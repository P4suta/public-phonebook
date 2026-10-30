import { expect, test } from "./fixtures.ts";

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
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).not.toContain("client-supplied");
  expect(csp).not.toBe(second.headers()["content-security-policy"]);
  expect(first.headers()["cache-control"]).toBe("no-store, no-transform");
  expect(first.headers()["set-cookie"]).toBeUndefined();
});

test("the browser keeps only screen positions for the tab and never the search words", async ({
  page,
}) => {
  const query = "国立国会図書館";
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await page.getByRole("searchbox").fill(query);
  const result = page.locator("article").first();
  await expect(result).toBeVisible();
  await result.getByRole("link", { name: /の情報を見る$/u }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page.locator("article").first()).toBeVisible();
  const stored = await page.evaluate(() => ({
    cookie: document.cookie,
    local: Object.keys(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(stored.cookie).toBe("");
  expect(stored.local).toEqual([]);
  for (const [key, value] of stored.session) {
    expect(key).toMatch(/^tsr-scroll-restoration/u);
    for (const form of [query, encodeURIComponent(query)])
      expect(value).not.toContain(form);
  }
});
