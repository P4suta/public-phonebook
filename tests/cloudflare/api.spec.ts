import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { array, contacts, object, string } from "../e2e/support.js";

test("the public API exposes reusable records, source links, complete exports and browser metadata through Cloudflare", async ({
  request,
}) => {
  const response = await request.get(
    "/api/contacts?q=%E6%A8%AA%E6%B5%9C%E5%B8%82%E5%BD%B9%E6%89%80",
    { headers: { origin: "https://consumer.example" } },
  );
  expect(response.status()).toBe(200);
  expect(response.headers()["access-control-allow-origin"]).toBe("*");
  const payload: unknown = await response.json();
  object(payload);
  const record = array(payload.data)[0];
  object(record);
  expect(record.name).toBe("横浜市役所");
  for (const name of [
    "source_url",
    "license",
    "license_url",
    "data_as_of",
    "retrieved_at",
    "attribution",
  ])
    expect(string(record[name]).length).toBeGreaterThan(0);
  object(record.links);
  const source = await request.get(string(record.links.source));
  expect(source.status()).toBe(200);
  const sourceBody: unknown = await source.json();
  object(sourceBody);
  object(sourceBody.data);
  expect(sourceBody.data.id).toBe(record.source_id);
  object(payload.exports);
  object(payload.meta);
  const total = payload.meta.total;
  if (typeof total !== "number" || !Number.isSafeInteger(total))
    throw new Error("Invalid result count");
  const exported = await request.get(string(payload.exports.json));
  expect(exported.status()).toBe(200);
  expect(contacts(await exported.text())).toHaveLength(total);
  const options = await request.fetch("/api/contacts", {
    method: "OPTIONS",
    headers: {
      origin: "https://consumer.example",
      "access-control-request-method": "GET",
    },
  });
  expect(options.status()).toBe(204);
  expect(options.headers()["access-control-allow-methods"]).toBe(
    "GET, HEAD, OPTIONS",
  );
  const document = await request.get("/api/openapi.json");
  const tag = string(document.headers().etag);
  const conditional = await request.get("/api/openapi.json", {
    headers: { "if-none-match": tag },
  });
  expect(conditional.status()).toBe(304);
  expect(conditional.headers()["access-control-allow-origin"]).toBe("*");
  expect(conditional.headers()["cache-control"]).toBe(
    "public, max-age=0, must-revalidate",
  );
  const invalid = await request.post("/api/contacts");
  expect(invalid.status()).toBe(405);
  expect(invalid.headers()["content-type"]).toBe("application/problem+json");
  const error: unknown = await invalid.json();
  object(error);
  expect(error.code).toBe("method_not_allowed");
  expect(error.request_id).toBe(invalid.headers()["x-request-id"]);
  const specification: unknown = await document.json();
  object(specification);
  object(specification.components);
  object(specification.components.schemas);
  object(specification.components.schemas.Problem);
  for (const name of array(specification.components.schemas.Problem.required))
    expect(error).toHaveProperty(string(name));
});

test("the API explorer serves its script and works on a narrow screen", async ({
  page,
}, info) => {
  await page.goto("/data");
  await page
    .getByRole("link", { name: "APIの使い方・リクエストを試す", exact: true })
    .click();
  await page.getByRole("button", { name: "JSONを取得", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("HTTP 200");
  await expect(
    page.getByLabel("APIのレスポンス", { exact: true }),
  ).toContainText("横浜市役所");
  await expect(
    page.getByLabel("レスポンスヘッダー", { exact: true }),
  ).toContainText("x-public-phonebook-snapshot");
  await page.setViewportSize({ width: 320, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  await page.screenshot({
    path: info.outputPath("public-api-320.png"),
    fullPage: true,
  });
});
