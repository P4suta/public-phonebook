import { createServer } from "node:http";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { array, object } from "./support.js";

test("developers can discover the API, try a request and select a runnable URL without credentials", async ({
  page,
  context,
  baseURL,
}, info) => {
  if (!baseURL) throw new Error("Missing test origin");
  await context.addCookies([
    { name: "private", value: "not-for-api", url: baseURL },
  ]);
  await page.goto("/data");
  await page
    .getByRole("link", { name: "APIの使い方・リクエストを試す", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Public Phonebook API", exact: true }),
  ).toBeVisible();
  await page.getByLabel("施設名か電話番号", { exact: true }).fill("試験");
  const requested = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/contacts",
  );
  await page.getByRole("button", { name: "JSONを取得", exact: true }).click();
  expect(await (await requested).headerValue("cookie")).toBeNull();
  const output = page.getByLabel("APIのレスポンス", { exact: true });
  await expect(output).toContainText("13:dental");
  await expect(output).toContainText("<script>");
  const raw: unknown = JSON.parse((await output.textContent()) ?? "null");
  object(raw);
  expect(array(raw.data)).toHaveLength(1);
  await expect(page.locator("script:not([src])")).toHaveCount(0);
  await expect(
    page.getByLabel("レスポンスヘッダー", { exact: true }),
  ).toContainText("x-public-phonebook-snapshot");
  const address = page.getByLabel("リクエストURL", { exact: true });
  const url = new URL(await address.inputValue());
  expect(url.searchParams.get("q")).toBe("試験");
  await expect(page.locator("#api-curl")).toContainText(url.href);
  await page.getByRole("button", { name: "URLを選択", exact: true }).click();
  expect(
    await address.evaluate((element: HTMLInputElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([0, (await address.inputValue()).length]);
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`api-docs-${width}.png`),
      fullPage: true,
    });
  }
});

test("external browser clients can fetch JSON and revalidate the schema across origins", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Missing test origin");
  const consumer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><html lang="en"><head><title>API consumer</title></head><body><h1>API consumer</h1></body></html>',
    );
  });
  await new Promise<void>((resolve, reject) => {
    consumer.once("error", reject);
    consumer.listen(0, "127.0.0.1", () => {
      consumer.off("error", reject);
      resolve();
    });
  });
  try {
    const address = consumer.address();
    if (!address || typeof address === "string")
      throw new Error("Missing consumer origin");
    await page.goto(`http://127.0.0.1:${address.port}`);
    const result = await page.evaluate(async (origin: string) => {
      const response = await fetch(
        new URL("/api/contacts?prefecture=13&category=medical", origin),
        { credentials: "omit", cache: "no-store" },
      );
      const data: unknown = await response.json();
      const schema = await fetch(new URL("/api/openapi.json", origin), {
        credentials: "omit",
        cache: "no-store",
      });
      const tag = schema.headers.get("etag");
      if (!tag) throw new Error("The schema validator header was not exposed");
      const conditional = await fetch(new URL("/api/openapi.json", origin), {
        credentials: "omit",
        cache: "no-store",
        headers: { "If-None-Match": tag },
      });
      return {
        status: response.status,
        snapshot: response.headers.get("x-public-phonebook-snapshot"),
        data,
        conditional: conditional.status,
        body: await conditional.text(),
      };
    }, baseURL);
    expect(result.status).toBe(200);
    expect(result.snapshot).toMatch(/^[a-f0-9]{64}$/);
    object(result.data);
    expect(array(result.data.data)).toHaveLength(1);
    expect(result.conditional).toBe(304);
    expect(result.body).toBe("");
  } finally {
    consumer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      consumer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("the API explorer shows HTTP problems and recovers after malformed responses", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/contacts?**", async (route) => {
    attempts += 1;
    if (attempts === 1)
      await route.fulfill({
        status: 503,
        contentType: "application/problem+json",
        headers: { "retry-after": "1" },
        json: { status: 503, code: "unavailable", detail: "Retry later" },
      });
    else if (attempts === 2)
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Invalid response</title>",
      });
    else await route.continue();
  });
  await page.goto("/api/docs");
  await page.getByLabel("施設名か電話番号", { exact: true }).fill("試験");
  const submit = page.getByRole("button", { name: "JSONを取得", exact: true });
  await submit.click();
  await expect(page.getByRole("status")).toContainText("HTTP 503");
  await expect(
    page.getByLabel("APIのレスポンス", { exact: true }),
  ).toContainText("unavailable");
  await expect(
    page.getByLabel("レスポンスヘッダー", { exact: true }),
  ).toContainText("retry-after: 1");
  await submit.click();
  await expect(page.getByRole("status")).toContainText("JSON形式を確認");
  await submit.click();
  await expect(page.getByRole("status")).toContainText("HTTP 200");
  await expect(
    page.getByLabel("APIのレスポンス", { exact: true }),
  ).toContainText("13:dental");
});

test("the inline API action appears only after a delayed module is ready", async ({
  page,
}) => {
  let release = (): void => {
    throw new Error("The script gate is not installed");
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api.js", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/api/docs", { waitUntil: "commit" });
    await expect(
      page.getByLabel("施設名か電話番号", { exact: true }),
    ).toBeVisible();
    const inline = page.getByRole("button", {
      name: "JSONを取得",
      exact: true,
    });
    const direct = page.getByRole("button", {
      name: "JSONを開く",
      exact: true,
    });
    await expect(inline).toBeHidden();
    await expect(direct).toBeVisible();
    await page.getByLabel("施設名か電話番号", { exact: true }).fill("試験");
    release();
    await expect(inline).toBeVisible();
    await expect(direct).toBeHidden();
    await inline.click();
    await expect(page.getByRole("status")).toContainText("HTTP 200");
    await expect(page).toHaveURL(/\/api\/docs$/);
    await expect(
      page.getByLabel("APIのレスポンス", { exact: true }),
    ).toContainText("13:dental");
  } finally {
    release();
  }
});

test.describe("the native API explorer", () => {
  test.use({ javaScriptEnabled: false });
  test("keeps labelled GET submission available without JavaScript", async ({
    page,
  }) => {
    await page.goto("/api/docs");
    await expect(
      page.getByRole("button", { name: "JSONを取得", exact: true }),
    ).toBeHidden();
    await page.getByLabel("施設名か電話番号", { exact: true }).fill("試験");
    const response = page.waitForResponse(
      (value) => new URL(value.url()).pathname === "/api/contacts",
    );
    await page.getByRole("button", { name: "JSONを開く", exact: true }).click();
    const result = await response;
    expect(result.status()).toBe(200);
    expect(new URL(result.url()).searchParams.get("q")).toBe("試験");
    const payload: unknown = await result.json();
    object(payload);
    expect(array(payload.data)).toHaveLength(1);
  });
});
