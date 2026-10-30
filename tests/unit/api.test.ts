import { Miniflare } from "miniflare";
import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  categoryDefinitions,
  prefectureNames,
} from "../../src/core/catalog.ts";
import {
  CatalogSchema,
  type Contact,
  ContactSchema,
  GroupedSearchResponseSchema,
  SearchResponseSchema,
} from "../../src/core/models.ts";
import { checkPageChain } from "../../src/core/page-chain.ts";
import {
  encodeCursor,
  nameTokens,
  normalizeName,
  parseSearch,
  searchKey,
} from "../../src/core/search.ts";
import { api, type DirectoryApiBindings } from "../../src/server/api.ts";
import type { DatasetObject } from "../../src/server/datasets.ts";
import { databaseSchema } from "../../tools/database-schema.ts";

const runtime = new Miniflare({
  cf: false,
  telemetry: { enabled: false },
  enableDevRegistry: false,
  unsafeEnableSharedStorage: false,
  workers: [
    {
      config: {
        name: "fixture",
        compatibilityDate: "2026-10-23",
        manifest: {
          mainModule: "fixture.js",
          modules: {
            "fixture.js": {
              type: "esm",
              contents:
                "export default { fetch() { return new Response('fixture'); } }",
            },
          },
        },
        env: {
          DB: { type: "d1", id: "fixture" },
          DATASETS: { type: "r2", name: "fixture" },
        },
      },
    },
  ],
});
let bindings: DirectoryApiBindings;
const snapshot = "1".repeat(64);
const contacts: Contact[] = Array.from({ length: 173 }, (_, index) =>
  v.parse(ContactSchema, {
    id: `fixture:${String(index).padStart(3, "0")}`,
    name:
      index === 0
        ? "図書館"
        : index % 4 === 0
          ? `図書館${index}`
          : `全国の図書館${index}`,
    category: index % 2 === 0 ? "library" : "medical",
    prefectureCode: index % 3 === 0 ? "13" : "14",
    municipalityCode: index % 3 === 0 ? "13101" : "14100",
    address: "所在地（本館）",
    phones: [{ display: "03-3581-2331", e164: "+81335812331" }],
    website: "https://example.org/",
    sourceId: "fixture",
    sourceRecordId: String(index),
    sourceUrls: ["https://example.org/data"],
    license: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    dataAsOf: "2026-10-01",
    retrievedAt: "2026-10-29T00:00:00Z",
    phoneConfirmed: false,
    phoneConfirmationUrl: null,
  }),
);

beforeAll(async () => {
  const DB = await runtime.getD1Database("DB");
  const bucket = await runtime.getR2Bucket("DATASETS");
  bindings = {
    DB,
    DATASETS: {
      async get(key: string): Promise<DatasetObject | null> {
        const object = await bucket.get(key, {});
        if (!object || !("body" in object)) return null;
        const bytes = new Uint8Array(await object.arrayBuffer());
        return {
          size: object.size,
          httpEtag: object.httpEtag,
          body: new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        };
      },
    },
    APP_ENV: "development",
    PUBLIC_ORIGIN: "http://localhost:8787",
  };
  await DB.exec(databaseSchema.replaceAll("\n", " "));
  const statements = contacts.flatMap((contact, index) => [
    DB.prepare("INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
      index + 1,
      contact.id,
      contact.name,
      normalizeName(contact.name),
      contact.prefectureCode,
      contact.municipalityCode,
      contact.category,
      contact.sourceId,
      JSON.stringify(contact),
    ),
    DB.prepare("INSERT INTO phones VALUES (?, ?)").bind(
      contact.phones[0]?.e164 ?? "",
      index + 1,
    ),
    DB.prepare("INSERT INTO contact_search(rowid, terms) VALUES (?, ?)").bind(
      index + 1,
      nameTokens(normalizeName(contact.name)).join(" "),
    ),
  ]);
  await DB.batch(statements);
  const catalog = v.parse(CatalogSchema, {
    snapshot,
    generatedAt: "2026-10-29T00:00:00Z",
    contacts: contacts.length,
    phones: 1,
    sourceCount: 1,
    categories: categoryDefinitions.map((category) => ({
      id: category.id,
      label: category.label,
      contacts: contacts.filter((contact) => contact.category === category.id)
        .length,
      publisher: "公開元",
      license: "CC0-1.0",
      licenseUrl: "https://example.org/license",
    })),
    prefectures: prefectureNames.map((name, index) => ({
      code: String(index + 1).padStart(2, "0"),
      name,
      contacts: 0,
    })),
    municipalities: [],
  });
  await DB.prepare("INSERT INTO metadata VALUES ('catalog', ?)")
    .bind(JSON.stringify(catalog))
    .run();
});

afterAll(async () => runtime.dispose());

async function request(path: string, init?: RequestInit): Promise<Response> {
  return api.fetch(new Request(`https://example.org${path}`, init), bindings);
}

describe("native D1 public API", () => {
  it("rejects duplicate categories, foreign rows, mixed snapshots, and false group totals", async () => {
    const body: unknown = await (
      await request("/api/contact-groups?q=図書館")
    ).json();
    const grouped = v.parse(GroupedSearchResponseSchema, body);
    const first = grouped.groups[0];
    if (!first) throw new Error("The group fixture is missing");
    const invalid = [
      { ...grouped, groups: [...grouped.groups, first] },
      { ...grouped, meta: { ...grouped.meta, total: 174 } },
      {
        ...grouped,
        groups: [{ ...first, category: "medical" }, ...grouped.groups.slice(1)],
      },
      { ...grouped, meta: { ...grouped.meta, snapshot: "2".repeat(64) } },
      {
        ...grouped,
        groups: [
          {
            ...first,
            results: {
              ...first.results,
              data: [...first.results.data, first.results.data[0]],
            },
          },
          ...grouped.groups.slice(1),
        ],
      },
    ];
    for (const candidate of invalid)
      expect(v.safeParse(GroupedSearchResponseSchema, candidate).success).toBe(
        false,
      );
  });

  it("previews every matching category and continues each without losing records", async () => {
    const response = await request("/api/contact-groups?q=図書館");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const grouped = v.parse(GroupedSearchResponseSchema, body);
    expect(grouped.meta).toEqual({ total: 173, snapshot });
    expect(grouped.groups.map((group) => group.category)).toEqual([
      "library",
      "medical",
    ]);
    expect(grouped.groups[0]?.results.data[0]?.id).toBe("fixture:000");
    const all: string[] = [];
    for (const group of grouped.groups) {
      expect(group.results.data).toHaveLength(3);
      expect(group.results.meta.total).toBe(
        group.category === "library" ? 87 : 86,
      );
      let page = group.results;
      const pages = [];
      const ids: string[] = [];
      for (;;) {
        expect(
          page.data.every((contact) => contact.category === group.category),
        ).toBe(true);
        ids.push(...page.data.map((contact) => contact.id));
        const next = page.links.next;
        if (!next) break;
        expect(new URL(next).pathname).toBe("/api/contacts");
        pages.push(page);
        const nextUrl = new URL(next);
        const nextResponse = await request(nextUrl.pathname + nextUrl.search);
        expect(nextResponse.status).toBe(200);
        const nextBody: unknown = await nextResponse.json();
        page = v.parse(SearchResponseSchema, nextBody);
        expect(
          checkPageChain(
            page,
            pages,
            nextUrl.searchParams.get("cursor") ?? "",
            snapshot,
          ).ok,
        ).toBe(true);
      }
      expect(new Set(ids).size).toBe(group.results.meta.total);
      expect(ids.length).toBe(group.results.meta.total);
      all.push(...ids);
    }
    expect(all.toSorted()).toEqual(
      contacts.map((contact) => contact.id).toSorted(),
    );
  });

  it("keeps group previews bounded and rejects unbound continuations", async () => {
    for (const query of [
      "cursor=abc",
      "q=x&q=y",
      "category=missing",
      "limit=101",
      "debug=1",
    ]) {
      expect(
        (await request(`/api/contact-groups?${query}`)).status,
        query,
      ).toBe(400);
    }
    const response = await request("/api/contact-groups?q=図書館&limit=1");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const grouped = v.parse(
      v.object({
        groups: v.array(v.object({ results: SearchResponseSchema })),
      }),
      body,
    );
    expect(grouped.groups).toHaveLength(2);
    expect(
      grouped.groups.every((group) => group.results.data.length === 1),
    ).toBe(true);
    const next = grouped.groups[0]?.results.links.next;
    if (!next) throw new Error("The group continuation is missing");
    const url = new URL(next);
    expect((await request(`/api/contact-groups${url.search}`)).status).toBe(
      200,
    );
    url.searchParams.set("category", "medical");
    expect((await request(`/api/contact-groups${url.search}`)).status).toBe(
      400,
    );
  });

  it("searches phone spellings consistently without extracting numbers from ambiguous input", async () => {
    for (const [q, expected] of [
      ["03-3581-2331", 173],
      ["０３―３５８１―２３３１", 173],
      ["0335812331", 173],
      ["03)3581-2331", 173],
      ["+81 3 3581 2331", 173],
      ["⓪③-3581-2331", 0],
      ["03\n35812331", 0],
      ["03-3581-2331 内線123", 0],
    ] as const) {
      const response = await request(
        `/api/contacts?${new URLSearchParams({ q })}`,
      );
      expect(response.status).toBe(200);
      const raw: unknown = await response.json();
      expect(v.parse(SearchResponseSchema, raw).meta.total, q).toBe(expected);
    }
  });
  it("allows category-only, region-only, and unfiltered API queries", async () => {
    for (const path of [
      "/api/contacts",
      "/api/contacts?prefecture=13&limit=1",
      "/api/contacts?category=library",
    ]) {
      const response = await request(path);
      expect(response.status, path).toBe(200);
    }
  });
  it("documents every accepted search parameter and the error contract", async () => {
    const response = await request("/api/openapi.json");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const documented = v.parse(
      v.object({
        paths: v.object({
          "/api/contacts": v.object({
            get: v.object({
              parameters: v.array(
                v.object({ name: v.string(), in: v.literal("query") }),
              ),
              responses: v.record(v.string(), v.unknown()),
            }),
          }),
        }),
      }),
      body,
    ).paths["/api/contacts"].get;
    expect(documented.parameters.map((parameter) => parameter.name)).toEqual([
      "q",
      "prefecture",
      "municipality",
      "category",
      "limit",
      "cursor",
    ]);
    for (const status of ["400", "409", "503"])
      expect(Object.hasOwn(documented.responses, status)).toBe(true);
  });
  it("rejects duplicate, looping, and mixed-snapshot result pages", async () => {
    const body: unknown = await (
      await request("/api/contacts?q=図書館&limit=7")
    ).json();
    const first = v.parse(SearchResponseSchema, body);
    const cursor = first.meta.nextCursor;
    if (!cursor) throw new Error("Missing fixture continuation");
    const nextBody: unknown = await (
      await request(`/api/contacts?q=図書館&limit=7&cursor=${cursor}`)
    ).json();
    const next = v.parse(SearchResponseSchema, nextBody);
    expect(checkPageChain(next, [first], cursor, snapshot).ok).toBe(true);
    expect(checkPageChain(first, [first], cursor, snapshot)).toEqual({
      ok: false,
      error: "invalid_page",
    });
    expect(checkPageChain(next, [first], cursor, "2".repeat(64))).toEqual({
      ok: false,
      error: "snapshot_changed",
    });
    expect(
      checkPageChain(
        { ...next, meta: { ...next.meta, nextCursor: cursor } },
        [first],
        cursor,
        snapshot,
      ).ok,
    ).toBe(false);
    expect(
      checkPageChain(
        { ...next, meta: { ...next.meta, total: 174 } },
        [first],
        cursor,
        snapshot,
      ).ok,
    ).toBe(false);
  });
  it("orders exact names before prefixes and substrings", async () => {
    const response = await request("/api/contacts?q=図書館");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const page = v.parse(SearchResponseSchema, body);
    expect(page.meta.total).toBe(173);
    expect(page.data[0]?.name).toBe("図書館");
    expect(
      page.data.slice(1).every((contact) => contact.name.startsWith("図書館")),
    ).toBe(true);
  });
  it("paginates every record once and preserves a combined filter", async () => {
    let path: string | null =
      "/api/contacts?q=図書館&prefecture=13&category=library&limit=7";
    const ids: string[] = [];
    while (path) {
      const response = await request(path);
      const body: unknown = await response.json();
      const page = v.parse(SearchResponseSchema, body);
      ids.push(...page.data.map((contact) => contact.id));
      path = page.links.next
        ? new URL(page.links.next).pathname + new URL(page.links.next).search
        : null;
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      contacts
        .filter(
          (contact) =>
            contact.prefectureCode === "13" && contact.category === "library",
        )
        .map((contact) => contact.id)
        .sort(),
    );
  });
  it("keeps SQL metacharacters literal and rejects ambiguous inputs", async () => {
    for (const query of [
      "q=x&q=y",
      "limit=0",
      "limit=101",
      "limit=NaN",
      "prefecture=13&municipality=14100",
      "debug=1",
      "__proto__=x",
      "constructor=x",
      "toString=x",
      "q=%FF",
    ]) {
      const response = await request(`/api/contacts?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.headers.get("Content-Type")).toContain(
        "application/problem+json",
      );
    }
    const response = await request("/api/contacts?q=%27OR+1%3D1--");
    const body: unknown = await response.json();
    expect(v.parse(SearchResponseSchema, body).meta.total).toBe(0);
  });
  it("binds a cursor to the snapshot and normalized query", async () => {
    const search = parseSearch(new URLSearchParams("q=図書館"));
    if (!search.ok) throw new Error("Fixture query rejected");
    const cursor = encodeCursor({
      snapshot: "2".repeat(64),
      query: await searchKey(search.value),
      rank: 0,
      name: "図書館",
      id: "fixture:000",
    });
    expect(
      (await request(`/api/contacts?q=図書館&cursor=${cursor}`)).status,
    ).toBe(409);
    const mismatched = encodeCursor({
      snapshot,
      query: "0".repeat(64),
      rank: 0,
      name: "図書館",
      id: "fixture:000",
    });
    expect(
      (await request(`/api/contacts?q=図書館&cursor=${mismatched}`)).status,
    ).toBe(400);
  });
  it("supports public CORS, HEAD, OPTIONS, and cache revalidation", async () => {
    const response = await request("/api/catalog");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const etag = response.headers.get("ETag");
    if (!etag) throw new Error("Catalog validator missing");
    expect(
      (await request("/api/catalog", { headers: { "If-None-Match": etag } }))
        .status,
    ).toBe(304);
    expect(
      await (await request("/api/catalog", { method: "HEAD" })).text(),
    ).toBe("");
    expect(
      (
        await request("/api/catalog", {
          method: "OPTIONS",
          headers: {
            Origin: "https://consumer.example",
            "Access-Control-Request-Method": "GET",
          },
        })
      ).status,
    ).toBe(204);
    expect((await request("/api/contacts", { method: "POST" })).status).toBe(
      405,
    );
  });
});
