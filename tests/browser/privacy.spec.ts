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
  expect(first.headers()["cache-control"]).toBe("no-store");
  expect(first.headers()["set-cookie"]).toBeUndefined();
});
