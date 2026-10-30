import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import * as v from "valibot";

test("the national category preview has exact counts and bounded payloads for every matching kind", async ({
  request,
}) => {
  test.setTimeout(120000);
  const catalogBody: unknown = await (await request.get("/api/catalog")).json();
  const catalog = v.parse(CatalogSchema, catalogBody);
  const started = performance.now();
  const response = await request.get("/api/contact-groups");
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  const grouped = v.parse(GroupedSearchResponseSchema, body);
  console.info(
    JSON.stringify({
      operation: "national.category-previews",
      durationMs: performance.now() - started,
      groups: grouped.groups.length,
      contacts: grouped.groups.reduce(
        (sum, group) => sum + group.results.data.length,
        0,
      ),
      total: grouped.meta.total,
    }),
  );
  expect(grouped.meta).toEqual({
    snapshot: catalog.snapshot,
    total: catalog.contacts,
  });
  expect(grouped.groups).toHaveLength(catalog.categories.length);
  for (const group of grouped.groups) {
    const expected = catalog.categories.find(
      (category) => category.id === group.category,
    );
    if (!expected) throw new Error("Unknown result category");
    expect(group.results.meta.total).toBe(expected.contacts);
    expect(group.results.data).toHaveLength(Math.min(3, expected.contacts));
    if (expected.contacts > 3) {
      expect(new URL(group.results.links.next ?? "").pathname).toBe(
        "/api/contacts",
      );
    } else {
      expect(group.results.links.next).toBeNull();
    }
  }
});

import {
  CatalogSchema,
  ContactSchema,
  DatasetManifestSchema,
  GroupedSearchResponseSchema,
  SearchResponseSchema,
} from "../../src/core/models.ts";

test("the native national catalog and every region and category are searchable", async ({
  request,
}) => {
  const catalogBody: unknown = await (await request.get("/api/catalog")).json();
  const catalog = v.parse(CatalogSchema, catalogBody);
  const localValue: unknown = JSON.parse(
    await readFile(".local/phonebook/catalog.json", "utf8"),
  );
  const local = v.parse(CatalogSchema, localValue);
  expect(catalog).toEqual(local);
  expect(catalog.prefectures).toHaveLength(47);
  expect(catalog.categories.length).toBeGreaterThan(39);
  console.info(
    JSON.stringify({
      operation: "national.api",
      origin: new URL((await request.get("/api")).url()).origin,
      contacts: catalog.contacts,
      categories: catalog.categories.length,
      prefectures: catalog.prefectures.length,
    }),
  );
  for (const [parameter, entries] of [
    [
      "prefecture",
      catalog.prefectures.map((item) => ({
        value: item.code,
        contacts: item.contacts,
      })),
    ],
    [
      "category",
      catalog.categories.map((item) => ({
        value: item.id,
        contacts: item.contacts,
      })),
    ],
  ] as const) {
    for (const entry of entries) {
      const response = await request.get(
        `/api/contacts?${new URLSearchParams({ [parameter]: entry.value, limit: "1" })}`,
      );
      expect(response.status(), `${parameter}=${entry.value}`).toBe(200);
      const body: unknown = await response.json();
      const result = v.parse(SearchResponseSchema, body);
      expect(result.meta.snapshot).toBe(catalog.snapshot);
      expect(result.meta.total).toBe(entry.contacts);
      expect(result.data).toHaveLength(1);
    }
  }
});

test("public API details, vCards, source records, and headers agree", async ({
  request,
}) => {
  const response = await request.get("/api/contacts?q=国立国会図書館");
  const body: unknown = await response.json();
  const page = v.parse(SearchResponseSchema, body);
  const first = page.data[0];
  if (!first) throw new Error("Known national library is missing");
  expect(first.name).toBe("国立国会図書館");
  const detail = await request.get(
    `/api/contacts/${encodeURIComponent(first.id)}`,
  );
  const detailBody: unknown = await detail.json();
  expect(v.parse(ContactSchema, detailBody)).toEqual(first);
  const source = await request.get(
    `/api/sources/${encodeURIComponent(first.sourceId)}`,
  );
  expect(source.status()).toBe(200);
  const card = await request.get(
    `/api/contacts/${encodeURIComponent(first.id)}/contact.vcf`,
  );
  expect(card.headers()["content-type"]).toContain("text/vcard");
  const text = await card.text();
  expect(text).toContain("TEL;TYPE=WORK,VOICE:+81335812331\r\n");
  expect(text).toContain("END:VCARD\r\n");
  for (const path of [
    "/api",
    "/api/openapi.json",
    "/api/catalog",
    "/api/contacts",
    "/api/contact-groups",
    "/api/sources",
    "/api/datasets",
  ]) {
    const result = await request.get(path);
    expect(result.status(), path).toBe(200);
    expect(result.headers()["access-control-allow-origin"]).toBe("*");
    expect(result.headers()["x-content-type-options"]).toBe("nosniff");
    expect(result.headers()["x-request-id"]).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.headers()["set-cookie"]).toBeUndefined();
  }
});

test("complete dataset downloads match their published checksums", async ({
  request,
}) => {
  test.setTimeout(120000);
  const body: unknown = await (await request.get("/api/datasets")).json();
  const manifest = v.parse(DatasetManifestSchema, body);
  for (const file of manifest.files) {
    const response = await request.get(file.url);
    expect(response.status()).toBe(200);
    const bytes = await response.body();
    expect(bytes.byteLength).toBe(file.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    const etag = response.headers().etag;
    if (!etag) throw new Error("The immutable download has no validator");
    expect(
      (
        await request.get(file.url, { headers: { "If-None-Match": etag } })
      ).status(),
    ).toBe(304);
    expect((await request.head(file.url)).status()).toBe(200);
    await response.dispose();
  }
});
