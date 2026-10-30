import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { Miniflare } from "miniflare";
import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  categoryDefinitions,
  prefectureNames,
} from "../../src/core/catalog.ts";
import { manifestObjectKey } from "../../src/core/dataset-storage.ts";
import { sha256 } from "../../src/core/identity.ts";
import {
  CatalogSchema,
  type Contact,
  ContactSchema,
  DatasetManifestSchema,
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
import {
  categoryPreviews,
  contactPage,
  directoryDatabase,
  searchSelection,
} from "../../src/server/database.ts";
import type { DatasetObject } from "../../src/server/datasets.ts";
import type { SearchCache } from "../../src/server/search-cache.ts";
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
          EMPTY: { type: "d1", id: "empty" },
          DATASETS: { type: "r2", name: "fixture" },
        },
      },
    },
  ],
});
let bindings: DirectoryApiBindings;
const snapshot = "1".repeat(64);
const preChangePages = 121;
const preChangeDigest =
  "cc5edfaccda7d63591da9837f9d36b01640eed6aa8f8ac4df0085a6a9fecd428";
const preChangeCursors = [
  [
    "/api/contacts?limit=7",
    "eyJzbmFwc2hvdCI6IjExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEiLCJxdWVyeSI6IjVmZjZjYzgwYzM0NDIxMjU3NDQyYjk2MGY2ZmRiZDVkOWNkZjM0YWQ3NGRjOTE5YjE3NTczZjU5OGRkMjkyNjAiLCJyYW5rIjowLCJuYW1lIjoi5YWo5Zu944Gu5Zuz5pu46aSoMTA2IiwiaWQiOiJmaXh0dXJlOjEwNiJ9",
    "9c31ab912030f39d5dc4cd8388ee48d22c8fa5bc5b463fb9a7ed2edec906773b",
  ],
  [
    "/api/contacts?q=03-3581-2331&limit=7",
    "eyJzbmFwc2hvdCI6IjExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEiLCJxdWVyeSI6IjE4YjU2Y2VkNTk3NjYzNjY2YzU1ZjBlZmVmNmFmMzlhNDAwNGViMDVjZmNlYzY4YzIwMDBhMjQ0NDBlNjlmMGYiLCJyYW5rIjowLCJuYW1lIjoi5YWo5Zu944Gu5Zuz5pu46aSoMTA2IiwiaWQiOiJmaXh0dXJlOjEwNiJ9",
    "f8873e2032c849f4fcde4115831a410bf6719de994b189507dea941e2fbc9229",
  ],
] as const;
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
        const reader = object.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const result: unknown = await reader.read();
            const part = v.parse(
              v.object({
                done: v.boolean(),
                value: v.optional(v.instance(Uint8Array)),
              }),
              result,
            );
            if (part.done) break;
            if (!part.value) throw new Error("Missing fixture object bytes");
            chunks.push(part.value);
            length += part.value.length;
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(length);
        let position = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, position);
          position += chunk.length;
        }
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
      contacts: contacts.filter(
        (contact) =>
          contact.prefectureCode === String(index + 1).padStart(2, "0"),
      ).length,
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
  it("binds each Worker version to immutable manifest bytes even when contact snapshots match", async () => {
    const bucket = await runtime.getR2Bucket("DATASETS");
    const manifest = {
      snapshot,
      generatedAt: "2026-10-30T00:00:00Z",
      contacts: contacts.length,
      phones: 1,
      sourceCount: 1,
      sourceDatabaseSha256: "1".repeat(64),
      databaseSha256: "2".repeat(64),
      files: ["contacts.jsonl.gz", "contacts.csv.gz", "contacts.vcf.gz"].map(
        (file) => ({
          file,
          sha256: "3".repeat(64),
          bytes: 1,
          url: `/api/datasets/${snapshot}/${"3".repeat(64)}/${file}`,
        }),
      ),
    };
    const first = JSON.stringify(manifest);
    expect(v.safeParse(DatasetManifestSchema, manifest).success).toBe(true);
    const digest = await sha256(first);
    const changed = JSON.stringify({
      ...manifest,
      databaseSha256: "4".repeat(64),
    });
    const key = manifestObjectKey(snapshot, digest);
    await bucket.put(key, first);
    expect(await bindings.DATASETS.get(key)).not.toBeNull();
    await bucket.put(manifestObjectKey(snapshot), changed);
    const production = {
      ...bindings,
      APP_ENV: "production",
      DATASET_MANIFEST_SHA256: digest,
    };
    const response = await api.fetch(
      new Request("https://www.dial.page/api/datasets"),
      production,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(manifest);
    expect(response.headers.get("cache-control")).toContain("no-cache");
    await bucket.put(key, changed);
    expect(
      (
        await api.fetch(
          new Request("https://www.dial.page/api/datasets"),
          production,
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await api.fetch(new Request("https://www.dial.page/api/datasets"), {
          ...production,
          DATASET_MANIFEST_SHA256: "",
        })
      ).status,
    ).toBe(503);
    expect(() => manifestObjectKey(snapshot, "../manifest")).toThrow();
  });
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

  it("leads with the category of an exact name and lists that name first", async () => {
    const response = await request(
      `/api/contact-groups?${new URLSearchParams({ q: "全国の図書館1" })}`,
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const grouped = v.parse(GroupedSearchResponseSchema, body);
    expect(grouped.groups.map((group) => group.category)).toEqual([
      "medical",
      "library",
    ]);
    expect(grouped.groups[0]?.results.data[0]?.name).toBe("全国の図書館1");
    expect(
      grouped.groups
        .flatMap((group) => group.results.data)
        .filter((contact) => contact.name === "全国の図書館1"),
    ).toHaveLength(1);
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
  it("keeps every broad search response identical to the window-ranked implementation", async () => {
    const digests: Record<string, string> = {};
    for (const start of [
      "/api/contacts?limit=7",
      "/api/contacts?q=03-3581-2331&limit=7",
      "/api/contacts?prefecture=13&limit=7",
      "/api/contacts?category=library&limit=7",
      "/api/contacts?municipality=13101&limit=7",
      "/api/contacts?prefecture=14&category=medical&limit=7",
      "/api/v1/contacts?limit=7",
    ]) {
      let path: string | null = start;
      for (let index = 0; path; index += 1) {
        const response = await request(path);
        const text = await response.text();
        digests[`${start}#${index}`] =
          `${response.status}:${await sha256(text)}`;
        const body: unknown = JSON.parse(text);
        const next = v.parse(SearchResponseSchema, body).links.next;
        path = next ? new URL(next).pathname + new URL(next).search : null;
      }
    }
    for (const path of [
      "/api/contact-groups",
      "/api/contact-groups?limit=1",
      "/api/contact-groups?limit=2",
      "/api/contact-groups?prefecture=13",
      "/api/v1/contact-groups",
      "/api/contacts.vcf?limit=5",
    ]) {
      const response = await request(path);
      digests[path] =
        `${response.status}:${await sha256(await response.text())}`;
    }
    expect(Object.keys(digests)).toHaveLength(preChangePages);
    expect(await sha256(JSON.stringify(digests))).toBe(preChangeDigest);
  });
  it("continues cursors issued before indexed ordering", async () => {
    for (const [path, cursor, digest] of preChangeCursors) {
      const response = await request(`${path}&cursor=${cursor}`);
      expect(response.status, path).toBe(200);
      expect(await sha256(await response.text()), path).toBe(digest);
    }
    const search = parseSearch(new URLSearchParams("limit=7"));
    if (!search.ok) throw new Error("Fixture query rejected");
    for (const rank of [1, 2] as const) {
      const cursor = encodeCursor({
        snapshot,
        query: await searchKey(search.value),
        rank,
        name: "全国の図書館106",
        id: "fixture:106",
      });
      const body: unknown = await (
        await request(`/api/contacts?limit=7&cursor=${cursor}`)
      ).json();
      const page = v.parse(SearchResponseSchema, body);
      expect(page.data).toEqual([]);
      expect(page.meta.nextCursor).toBeNull();
    }
  });
  it("takes totals without a name term from exact catalog counts", async () => {
    const DB = await runtime.getD1Database("DB");
    const stored = v.parse(
      v.object({ payload: v.string() }),
      await DB.prepare(
        "SELECT payload FROM metadata WHERE key = 'catalog'",
      ).first(),
    ).payload;
    const catalog = v.parse(CatalogSchema, JSON.parse(stored));
    const marked = {
      ...catalog,
      contacts: catalog.contacts + 1000,
      prefectures: catalog.prefectures.map((item) =>
        item.code === "13" ? { ...item, contacts: item.contacts + 1000 } : item,
      ),
      categories: catalog.categories.map((item) =>
        item.id === "library"
          ? { ...item, contacts: item.contacts + 1000 }
          : item,
      ),
    };
    const total = async (path: string): Promise<number> => {
      const body: unknown = await (await request(path)).json();
      return v.parse(SearchResponseSchema, body).meta.total;
    };
    const update = DB.prepare(
      "UPDATE metadata SET payload = ? WHERE key = 'catalog'",
    );
    await update.bind(JSON.stringify(marked)).run();
    try {
      expect(await total("/api/contacts")).toBe(1173);
      expect(await total("/api/contacts?prefecture=13")).toBe(1058);
      expect(await total("/api/contacts?category=library")).toBe(1087);
      expect(await total("/api/contacts?municipality=13101")).toBe(58);
      expect(await total("/api/contacts?prefecture=13&category=library")).toBe(
        29,
      );
      expect(await total("/api/contacts?q=図書館")).toBe(173);
      expect(await total("/api/contacts?q=03-3581-2331")).toBe(173);
      expect(await total("/api/contacts?category=pharmacy")).toBe(0);
    } finally {
      await update.bind(stored).run();
    }
    expect(await total("/api/contacts")).toBe(173);
  });
  it("previews unfiltered categories from indexed rows with catalog totals", async () => {
    const order = (first: Contact, second: Contact): number =>
      normalizeName(first.name) < normalizeName(second.name)
        ? -1
        : normalizeName(first.name) > normalizeName(second.name)
          ? 1
          : first.id < second.id
            ? -1
            : 1;
    for (const limit of [1, 2, 3, 30]) {
      const body: unknown = await (
        await request(`/api/contact-groups?limit=${limit}`)
      ).json();
      const grouped = v.parse(GroupedSearchResponseSchema, body);
      const expected = ["library", "medical"]
        .map((category) =>
          contacts
            .filter((contact) => contact.category === category)
            .toSorted(order),
        )
        .toSorted((first, second) =>
          first[0] && second[0] ? order(first[0], second[0]) : 0,
        );
      expect(grouped.meta.total).toBe(contacts.length);
      expect(grouped.groups.map((group) => group.category)).toEqual(
        expected.map((members) => members[0]?.category),
      );
      for (const [index, group] of grouped.groups.entries()) {
        const members = expected[index] ?? [];
        expect(group.results.meta.total).toBe(members.length);
        expect(group.results.data.map((contact) => contact.id)).toEqual(
          members.slice(0, Math.min(3, limit)).map((contact) => contact.id),
        );
      }
    }
  });
  it("plans searches without a name term through the contact_name index", async () => {
    const DB = await runtime.getD1Database("DB");
    const db = directoryDatabase(DB);
    const plan = async (query: {
      readonly sql: string;
      readonly params: readonly unknown[];
    }): Promise<string[]> => {
      const result = await DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(...query.params)
        .all();
      return v
        .parse(v.array(v.object({ detail: v.string() })), result.results)
        .map((row) => row.detail);
    };
    const parsed = parseSearch(new URLSearchParams("limit=30"));
    if (!parsed.ok) throw new Error("Fixture query rejected");
    const selection = await searchSelection(db, parsed.value);
    const after = {
      snapshot,
      query: await searchKey(parsed.value),
      rank: 0,
      name: "全国の図書館106",
      id: "fixture:106",
    } as const;
    for (const query of [
      contactPage(db, selection, null, 30).toSQL(),
      contactPage(db, selection, after, 30).toSQL(),
    ]) {
      const details = await plan(query);
      expect(details.join("\n")).toMatch(
        /USING (?:COVERING )?INDEX contact_name/,
      );
      expect(details.join("\n")).not.toMatch(/TEMP B-TREE/);
    }
    const continued = await plan(contactPage(db, selection, after, 30).toSQL());
    expect(continued.join("\n")).toContain("(normalized_name,id)>(?,?)");
    const page = contactPage(db, selection, null, 30).toSQL();
    const ranked = page.sql.replace(
      'order by "contacts"."normalized_name"',
      'order by CAST(0 AS INTEGER) asc, "contacts"."normalized_name"',
    );
    expect(ranked).not.toBe(page.sql);
    expect((await plan({ ...page, sql: ranked })).join("\n")).toMatch(
      /TEMP B-TREE FOR ORDER BY/,
    );
    const preview = new SQLiteAsyncDialect().sqlToQuery(
      categoryPreviews(["library", "medical"], 3),
    );
    const previewPlan = (await plan(preview)).join("\n");
    expect(previewPlan).toMatch(/USING (?:COVERING )?INDEX contact_category/);
    expect(previewPlan).not.toMatch(/SCAN (?:contacts|preview)\b/);
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

class MemoryCache implements SearchCache {
  readonly entries = new Map<string, Response>();
  readonly reads: string[] = [];
  failing = false;

  async match(request: Request): Promise<Response | undefined> {
    this.reads.push(request.url);
    if (this.failing) throw new Error("Cache unavailable");
    return this.entries.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    if (this.failing) throw new Error("Cache unavailable");
    this.entries.set(request.url, response);
  }
}

describe("dataset-bound search cache", () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  const firstVersion = "11111111-1111-4111-8111-111111111111";
  const secondVersion = "22222222-2222-4222-8222-222222222222";
  async function cachedRequest(
    path: string,
    cache: MemoryCache,
    options: {
      readonly digest?: string;
      readonly version?: string | null;
      readonly empty?: boolean;
      readonly method?: string;
    } = {},
  ): Promise<Response> {
    const version =
      options.version === null ? {} : { id: options.version ?? firstVersion };
    return api.fetch(
      new Request(`https://www.dial.page${path}`, {
        method: options.method ?? "GET",
      }),
      {
        ...bindings,
        ...(options.empty ? { DB: await runtime.getD1Database("EMPTY") } : {}),
        APP_ENV: "production",
        DATASET_MANIFEST_SHA256: options.digest ?? first,
        ...("id" in version ? { CF_VERSION_METADATA: version } : {}),
        SEARCH_CACHE: cache,
      },
    );
  }

  it("serves a repeated search for the same dataset without a database query", async () => {
    for (const path of [
      "/api/contacts?q=図書館&limit=5",
      "/api/contact-groups?q=図書館",
      `/api/v1/contacts?limit=5&snapshot=${snapshot}`,
      "/api/v1/contact-groups",
    ]) {
      const cache = new MemoryCache();
      const miss = await cachedRequest(path, cache);
      const body = await miss.text();
      expect(miss.status, path).toBe(200);
      expect(miss.headers.get("Cache-Control")).toBe(
        "public, no-cache, must-revalidate",
      );
      const url = new URL(`https://www.dial.page${path}`);
      const key = `https://www.dial.page/${firstVersion}/${first}${url.pathname}${url.search}`;
      expect([...cache.entries.keys()]).toEqual([key]);
      const stored = cache.entries.get(key);
      expect(stored?.headers.get("Cache-Control")).toBe("public, max-age=300");
      expect(stored?.headers.has("X-Request-Id")).toBe(false);
      const hit = await cachedRequest(path, cache, { empty: true });
      expect(hit.status, path).toBe(200);
      expect(await hit.text()).toBe(body);
      expect(hit.headers.get("Cache-Control")).toBe(
        "public, no-cache, must-revalidate",
      );
      expect(hit.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/u);
      expect(hit.headers.get("X-Request-Id")).not.toBe(
        miss.headers.get("X-Request-Id"),
      );
      for (const header of [
        "Content-Type",
        "X-Dataset-Snapshot",
        "X-Directory-API-Version",
        "Access-Control-Allow-Origin",
        "X-Content-Type-Options",
        "Content-Security-Policy",
      ])
        expect(hit.headers.get(header), header).toBe(miss.headers.get(header));
      const head = await cachedRequest(path, cache, {
        empty: true,
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(cache.entries.size).toBe(1);
    }
  });

  it("separates datasets and Worker versions and never stores problem responses", async () => {
    const cache = new MemoryCache();
    expect((await cachedRequest("/api/contacts?q=図書館", cache)).status).toBe(
      200,
    );
    for (const changedBinding of [
      { digest: second },
      { version: secondVersion },
    ]) {
      const changed = await cachedRequest("/api/contacts?q=図書館", cache, {
        ...changedBinding,
        empty: true,
      });
      expect(changed.status).toBe(503);
      expect(changed.headers.get("Content-Type")).toContain(
        "application/problem+json",
      );
    }
    const search = parseSearch(new URLSearchParams("q=図書館"));
    if (!search.ok) throw new Error("Fixture query rejected");
    const stale = encodeCursor({
      snapshot: "2".repeat(64),
      query: await searchKey(search.value),
      rank: 0,
      name: "図書館",
      id: "fixture:000",
    });
    for (const [path, status] of [
      ["/api/contacts?q=x&q=y", 400],
      ["/api/contact-groups?cursor=abc", 400],
      [`/api/contacts?q=図書館&cursor=${stale}`, 409],
      [`/api/v1/contacts?snapshot=${"2".repeat(64)}`, 409],
    ] as const)
      expect((await cachedRequest(path, cache)).status, path).toBe(status);
    expect([...cache.entries.keys()]).toEqual([
      `https://www.dial.page/${firstVersion}/${first}/api/contacts?q=%E5%9B%B3%E6%9B%B8%E9%A4%A8`,
    ]);
    expect(
      (await cachedRequest("/api/contacts?q=図書館", cache, { digest: second }))
        .status,
    ).toBe(200);
    expect(cache.entries.size).toBe(2);
  });

  it("bypasses the cache without a dataset digest or Worker version, outside search, or when it fails", async () => {
    const cache = new MemoryCache();
    for (const digest of ["", "A".repeat(64), "a".repeat(63)])
      expect(
        (await cachedRequest("/api/contacts", cache, { digest })).status,
      ).toBe(200);
    for (const version of [null, ""])
      expect(
        (await cachedRequest("/api/contacts", cache, { version })).status,
      ).toBe(200);
    for (const path of [
      "/api/catalog",
      "/api/contacts/fixture:000",
      "/api/contacts.vcf?limit=1",
      "/api/v1",
    ])
      expect((await cachedRequest(path, cache)).status, path).toBe(200);
    expect(cache.reads).toEqual([]);
    expect(cache.entries.size).toBe(0);
    cache.failing = true;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await cachedRequest("/api/contacts?limit=1", cache);
      expect(response.status).toBe(200);
      expect(cache.reads).toHaveLength(1);
      expect(warning.mock.calls).toEqual([
        ['{"operation":"search.cache.store","outcome":"failed"}'],
      ]);
    } finally {
      warning.mockRestore();
    }
  });
});
