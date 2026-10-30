import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import * as v from "valibot";
import {
  CatalogSchema,
  DatasetManifestSchema,
  GroupedSearchResponseSchema,
} from "../../src/core/models.ts";

test("the public catalog and grouped API retain the checked national publication", async ({
  request,
}) => {
  const local = v.parse(
    DatasetManifestSchema,
    JSON.parse(
      await readFile(
        resolve(
          process.env.DIAL_PUBLIC_BUNDLE ?? ".local/phonebook",
          "manifest.ready.json",
        ),
        "utf8",
      ),
    ),
  );
  const response = await request.get("/api/catalog");
  expect(response.status()).toBe(200);
  const catalog = v.parse(CatalogSchema, await response.json());
  expect(catalog.snapshot).toBe(local.snapshot);
  expect(catalog.contacts).toBe(local.contacts);
  const catalogValue: unknown = JSON.parse(
    await readFile(
      resolve(
        process.env.DIAL_PUBLIC_BUNDLE ?? ".local/phonebook",
        "catalog.json",
      ),
      "utf8",
    ),
  );
  expect(catalog).toEqual(v.parse(CatalogSchema, catalogValue));
  expect(catalog.prefectures).toHaveLength(47);
  const grouped = v.parse(
    GroupedSearchResponseSchema,
    await (await request.get("/api/contact-groups?q=図書館")).json(),
  );
  expect(grouped.meta.snapshot).toBe(local.snapshot);
  expect(
    grouped.groups.some(
      (group) => group.category === "library" && group.results.data.length > 0,
    ),
  ).toBe(true);
  const invalid = await request.get("/api/contacts?limit=101");
  expect(invalid.status()).toBe(400);
  expect(invalid.headers()["content-type"]).toContain(
    "application/problem+json",
  );
  const longQuery = await request.get(`/api/contacts?q=${"a".repeat(512)}`);
  expect(longQuery.status()).toBe(200);
});

test("every published archive matches its exact checked bytes", async ({
  request,
  baseURL,
}) => {
  test.setTimeout(180000);
  if (!baseURL) throw new Error("Missing public origin");
  const local = v.parse(
    DatasetManifestSchema,
    JSON.parse(
      await readFile(
        resolve(
          process.env.DIAL_PUBLIC_BUNDLE ?? ".local/phonebook",
          "manifest.ready.json",
        ),
        "utf8",
      ),
    ),
  );
  const response = await request.get("/api/datasets");
  expect(response.status()).toBe(200);
  const remote = v.parse(DatasetManifestSchema, await response.json());
  expect(remote).toEqual(local);
  for (const file of remote.files) {
    const archive = await fetch(new URL(file.url, baseURL), {
      redirect: "error",
    });
    expect(archive.status).toBe(200);
    if (!archive.body) throw new Error("Missing archive body");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of archive.body) {
      const value: unknown = chunk;
      if (!(value instanceof Uint8Array))
        throw new Error("Expected archive bytes");
      hash.update(value);
      bytes += value.length;
    }
    expect(bytes).toBe(file.bytes);
    expect(hash.digest("hex")).toBe(file.sha256);
  }
});
