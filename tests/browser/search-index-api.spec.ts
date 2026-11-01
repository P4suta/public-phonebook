import { expect, test } from "@playwright/test";
import * as v from "valibot";
import { SearchIndexLocationSchema } from "../../src/core/dataset-storage.ts";
import { CatalogSchema, RowLocationSchema } from "../../src/core/models.ts";

const staleSnapshot = "0".repeat(64);
const searchReturn = "/?q=%E5%9B%B3%E6%9B%B8%E9%A4%A8";

test("the built Worker locates the current search index", async ({
  request,
}) => {
  const catalog = v.parse(
    CatalogSchema,
    await (await request.get("/api/catalog")).json(),
  );
  const response = await request.get("/api/search-index");
  expect(response.status()).toBe(200);
  const location = v.parse(SearchIndexLocationSchema, await response.json());
  expect(location.snapshot).toBe(catalog.snapshot);
  expect(response.headers()["x-dataset-snapshot"]).toBe(catalog.snapshot);
});

test("a row page redirects to the canonical contact page and keeps the search to return to", async ({
  request,
}) => {
  const { snapshot, contacts } = v.parse(
    CatalogSchema,
    await (await request.get("/api/catalog")).json(),
  );
  for (const row of [0, contacts - 1]) {
    const located = v.parse(
      RowLocationSchema,
      await (await request.get(`/api/contacts/row/${snapshot}/${row}`)).json(),
    );
    const contactPath = `/contacts/${encodeURIComponent(located.id)}`;
    const page = await request.get(`/contacts/row/${snapshot}/${row}`, {
      maxRedirects: 0,
    });
    expect(page.status()).toBe(303);
    expect(page.headers().location).toBe(contactPath);
    const returning = await request.get(
      `/contacts/row/${snapshot}/${row}?from=${encodeURIComponent(searchReturn)}`,
      { maxRedirects: 0 },
    );
    expect(returning.status()).toBe(303);
    expect(returning.headers().location).toBe(
      `${contactPath}?from=${encodeURIComponent(searchReturn)}`,
    );
  }
  for (const path of [
    `/contacts/row/${snapshot}/${contacts}`,
    `/contacts/row/${snapshot}/01`,
    "/contacts/row/abc/0",
  ]) {
    const missing = await request.get(path, { maxRedirects: 0 });
    expect(missing.status(), path).toBe(404);
  }
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("a row page opens the contact and a stale row explains the update", async ({
    page,
    request,
  }) => {
    const { snapshot } = v.parse(
      CatalogSchema,
      await (await request.get("/api/catalog")).json(),
    );
    const located = v.parse(
      RowLocationSchema,
      await (await request.get(`/api/contacts/row/${snapshot}/0`)).json(),
    );
    await page.goto(`/contacts/row/${snapshot}/0`);
    expect(new URL(page.url()).pathname).toBe(
      `/contacts/${encodeURIComponent(located.id)}`,
    );
    const stale = await page.goto(
      `/contacts/row/${staleSnapshot}/0?from=${encodeURIComponent(searchReturn)}`,
    );
    expect(stale?.status()).toBe(409);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "電話番号のデータが新しくなりました",
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "施設をえらんだあとに、データが新しくなりました。もう一度さがしてください。",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "さがす画面にもどる" }),
    ).toHaveAttribute("href", searchReturn);
  });
});
