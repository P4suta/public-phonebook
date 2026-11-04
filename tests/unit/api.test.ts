import { createHash } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { Miniflare, type Response as WorkerResponse } from "miniflare";
import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  categoryDefinitions,
  prefectureNames,
} from "../../src/core/catalog.ts";
import {
  DatasetFileListingSchema,
  DirectoryDeltaListingSchema,
  datasetFileFormats,
  manifestObjectKey,
  PreparedDatasetManifestSchema,
  SearchIndexLocationSchema,
  searchIndexObjectKey,
} from "../../src/core/dataset-storage.ts";
import { sha256 } from "../../src/core/identity.ts";
import {
  CatalogSchema,
  type Contact,
  ContactSchema,
  DatasetManifestSchema,
  GroupedSearchResponseSchema,
  ProblemSchema,
  RowLocationSchema,
  SearchResponseSchema,
} from "../../src/core/models.ts";
import { checkPageChain } from "../../src/core/page-chain.ts";
import {
  encodeCursor,
  normalizeName,
  parseSearch,
  searchKey,
} from "../../src/core/search.ts";
import {
  api,
  type DirectoryApiBindings,
  openDataPath,
} from "../../src/server/api.ts";
import {
  categoryPreviews,
  contactPage,
  directoryDatabase,
  searchSelection,
} from "../../src/server/database.ts";
import type {
  DatasetByteRange,
  DatasetObject,
  DatasetObjectMetadata,
} from "../../src/server/datasets.ts";
import type { SearchCache } from "../../src/server/search-cache.ts";
import { databaseSchema } from "../../tools/database-schema.ts";
import { contactSeedStatements } from "../../tools/directory-fixture.ts";
import { apiWorkerEntry, bundledApi } from "./workerd-fixture.ts";

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
        compatibilityFlags: ["nodejs_compat"],
        manifest: {
          mainModule: "worker.js",
          modules: {
            "worker.js": { type: "esm", contents: apiWorkerEntry },
            "api.js": { type: "esm", contents: await bundledApi() },
          },
        },
        env: {
          DB: { type: "d1", id: "fixture" },
          EMPTY: { type: "d1", id: "empty" },
          DATASETS: { type: "r2", name: "fixture" },
          APP_ENV: { type: "text", value: "development" },
          PUBLIC_ORIGIN: { type: "text", value: "http://localhost:8787" },
        },
      },
    },
  ],
});
let bindings: DirectoryApiBindings;
const snapshot = "1".repeat(64);
const preChangePages = 94;
const preChangeDigest =
  "534da13f65a03d21ba567eb4b3e21eb7a99a7d77661f57808a173ff15d578a2d";
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
      async head(key: string): Promise<DatasetObjectMetadata | null> {
        const object = await bucket.head(key);
        return object && { size: object.size, httpEtag: object.httpEtag };
      },
      async get(
        key: string,
        options?: { readonly range?: DatasetByteRange },
      ): Promise<DatasetObject | null> {
        const object = await bucket.get(
          key,
          options?.range ? { range: options.range } : {},
        );
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
  const rowNumbers = new Map(
    contacts.map((contact, index) => [contact.id, index + 1]),
  );
  await DB.batch(
    contactSeedStatements(contacts, rowNumbers).map((statement) =>
      DB.prepare(statement.sql).bind(...statement.params),
    ),
  );
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

/** Asks workerd for the whole response, so each page of a long walk crosses from Node once. */
async function served(path: string): Promise<WorkerResponse> {
  return runtime.dispatchFetch(`https://example.org${path}`);
}

describe("native D1 public API", () => {
  it("binds each Worker version to immutable manifest bytes even when contact snapshots match", async () => {
    const bucket = await runtime.getR2Bucket("DATASETS");
    const listing = {
      snapshot,
      generatedAt: "2026-10-30T00:00:00Z",
      contacts: contacts.length,
      phones: 1,
      sourceCount: 1,
      sourceDatabaseSha256: "1".repeat(64),
      databaseSha256: "2".repeat(64),
      files: (
        [
          "contacts.jsonl.gz",
          "contacts.csv.gz",
          "contacts.vcf.gz",
          "directory.tsv.br",
        ] as const
      ).map((file) => ({
        file,
        sha256: "3".repeat(64),
        bytes: 1,
        url: `/api/datasets/${snapshot}/${"3".repeat(64)}/${file}`,
      })),
    };
    const manifest = {
      ...listing,
      searchIndex: {
        file: "search-index.br",
        sha256: "5".repeat(64),
        bytes: 1,
        uncompressedSha256: "6".repeat(64),
        uncompressedBytes: 2,
      },
    };
    const first = JSON.stringify(manifest);
    expect(v.safeParse(DatasetManifestSchema, listing).success).toBe(true);
    expect(v.safeParse(PreparedDatasetManifestSchema, manifest).success).toBe(
      true,
    );
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
    const listed = {
      ...listing,
      files: listing.files.map(({ file, ...stored }) => ({
        file,
        format: datasetFileFormats[file],
        ...stored,
      })),
      datasetDeltas: `/api/dataset-deltas?snapshot=${snapshot}`,
    };
    expect(await response.text()).toBe(JSON.stringify(listed));
    expect(v.is(DatasetFileListingSchema, listed)).toBe(true);
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(
      (
        await api.fetch(
          new Request("https://www.dial.page/api/v1/datasets"),
          production,
        )
      ).status,
    ).toBe(404);
    const unindexed = JSON.stringify(listing);
    const unindexedDigest = await sha256(unindexed);
    await bucket.put(manifestObjectKey(snapshot, unindexedDigest), unindexed);
    expect(
      (
        await api.fetch(new Request("https://www.dial.page/api/datasets"), {
          ...production,
          DATASET_MANIFEST_SHA256: unindexedDigest,
        })
      ).status,
    ).toBe(503);
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
  it("lists directory deltas from the bound manifest and serves them immutably", async () => {
    const bucket = await runtime.getR2Bucket("DATASETS");
    const listing = {
      snapshot,
      generatedAt: "2026-10-30T00:00:00Z",
      contacts: contacts.length,
      phones: 1,
      sourceCount: 1,
      sourceDatabaseSha256: "1".repeat(64),
      databaseSha256: "2".repeat(64),
      files: [
        "contacts.jsonl.gz",
        "contacts.csv.gz",
        "contacts.vcf.gz",
        "directory.tsv.br",
      ].map((file) => ({
        file,
        sha256: "3".repeat(64),
        bytes: 1,
        url: `/api/datasets/${snapshot}/${"3".repeat(64)}/${file}`,
      })),
    };
    const searchIndex = {
      file: "search-index.br",
      sha256: "5".repeat(64),
      bytes: 1,
      uncompressedSha256: "6".repeat(64),
      uncompressedBytes: 2,
    };
    const deltaBytes = new TextEncoder().encode("delta bytes");
    const deltaSha256 = createHash("sha256").update(deltaBytes).digest("hex");
    const base = "7a".repeat(32);
    const file = `directory-delta-${base}.tsv.br`;
    const artifact = {
      base,
      baseArchiveSha256: "8".repeat(64),
      file,
      sha256: deltaSha256,
      bytes: deltaBytes.byteLength,
      uncompressedSha256: "9".repeat(64),
      uncompressedBytes: 40,
    };
    const manifest = JSON.stringify({
      ...listing,
      searchIndex,
      deltas: [artifact],
    });
    const digest = await sha256(manifest);
    await bucket.put(manifestObjectKey(snapshot, digest), manifest);
    await bucket.put(`${snapshot}/${deltaSha256}/${file}`, deltaBytes);
    const legacy = JSON.stringify({ ...listing, searchIndex });
    const legacyDigest = await sha256(legacy);
    await bucket.put(manifestObjectKey(snapshot, legacyDigest), legacy);
    const fetch = async (
      path: string,
      manifestSha256 = digest,
    ): Promise<Response> =>
      api.fetch(new Request(`https://www.dial.page${path}`), {
        ...bindings,
        APP_ENV: "production",
        DATASET_MANIFEST_SHA256: manifestSha256,
      });

    const datasets: unknown = await (await fetch("/api/datasets")).json();
    const { datasetDeltas, ...listed } = v.parse(
      DatasetFileListingSchema,
      datasets,
    );
    expect(datasets).not.toHaveProperty("deltas");
    expect(datasetDeltas).toBe(`/api/dataset-deltas?snapshot=${snapshot}`);
    expect({
      ...listed,
      files: listed.files.map(({ format: _format, ...stored }) => stored),
    }).toEqual(listing);
    for (const path of ["/api/dataset-deltas", datasetDeltas]) {
      const response = await fetch(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("X-Dataset-Snapshot")).toBe(snapshot);
      expect(response.headers.get("Cache-Control")).toContain("no-cache");
      const url = `/api/datasets/${snapshot}/${deltaSha256}/${file}`;
      expect(
        v.parse(DirectoryDeltaListingSchema, await response.json()),
      ).toEqual({
        snapshot,
        archiveSha256: "3".repeat(64),
        deltas: [
          { ...artifact, format: "public-phonebook-directory-delta/1", url },
        ],
      });
      const download = await fetch(url);
      expect(download.status).toBe(200);
      expect(download.headers.get("Content-Type")).toBe(
        "application/octet-stream",
      );
      expect(download.headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(download.headers.get("Content-Disposition")).toBe(
        `attachment; filename="${file}"`,
      );
      expect(download.headers.get("X-Dataset-Snapshot")).toBe(snapshot);
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(deltaBytes);
      const etag = download.headers.get("ETag") ?? "";
      expect(
        (
          await api.fetch(
            new Request(`https://www.dial.page${url}`, {
              headers: { "If-None-Match": etag },
            }),
            bindings,
          )
        ).status,
      ).toBe(304);
    }
    expect(
      (await fetch(`/api/dataset-deltas?snapshot=${"0".repeat(64)}`)).status,
    ).toBe(409);
    expect((await fetch("/api/dataset-deltas?snapshot=x")).status).toBe(400);
    for (const path of [
      "/api/v1/dataset-deltas",
      `/api/v1/datasets/${snapshot}/${deltaSha256}/${file}`,
    ])
      expect((await fetch(path)).status, path).toBe(404);
    for (const name of [
      `directory-delta-${base}.tsv`,
      `directory-delta-${base.toUpperCase()}.tsv.br`,
      "directory-delta-7.tsv.br",
    ])
      expect(
        (await fetch(`/api/datasets/${snapshot}/${deltaSha256}/${name}`))
          .status,
        name,
      ).toBe(404);
    expect(
      await (await fetch("/api/dataset-deltas", legacyDigest)).json(),
    ).toEqual({ snapshot, archiveSha256: "3".repeat(64), deltas: [] });
    expect((await fetch("/api/dataset-deltas", "")).status).toBe(503);
  });
  it("revalidates both listings with a strong ETag of the body after the pin check", async () => {
    const bucket = await runtime.getR2Bucket("DATASETS");
    const manifestWith = (archiveSha256: string): string =>
      JSON.stringify({
        snapshot,
        generatedAt: "2026-10-30T00:00:00Z",
        contacts: contacts.length,
        phones: 1,
        sourceCount: 1,
        sourceDatabaseSha256: "1".repeat(64),
        databaseSha256: "2".repeat(64),
        files: [
          "contacts.jsonl.gz",
          "contacts.csv.gz",
          "contacts.vcf.gz",
          "directory.tsv.br",
        ].map((file) => {
          const sha256 =
            file === "directory.tsv.br" ? archiveSha256 : "3".repeat(64);
          return {
            file,
            sha256,
            bytes: 1,
            url: `/api/datasets/${snapshot}/${sha256}/${file}`,
          };
        }),
        searchIndex: {
          file: "search-index.br",
          sha256: "5".repeat(64),
          bytes: 1,
          uncompressedSha256: "6".repeat(64),
          uncompressedBytes: 2,
        },
        deltas: [],
      });
    const manifests = [
      manifestWith("3".repeat(64)),
      manifestWith("4".repeat(64)),
    ];
    const [current = "", changed = ""] = await Promise.all(
      manifests.map(async (manifest) => {
        const digest = await sha256(manifest);
        await bucket.put(manifestObjectKey(snapshot, digest), manifest);
        return digest;
      }),
    );
    const fetch = async (
      path: string,
      init: RequestInit = {},
      manifestSha256 = current,
    ): Promise<Response> =>
      api.fetch(new Request(`https://www.dial.page${path}`, init), {
        ...bindings,
        APP_ENV: "production",
        DATASET_MANIFEST_SHA256: manifestSha256,
      });
    const unrelatedTag = `"${"0".repeat(64)}"`;

    for (const path of [
      "/api/datasets",
      `/api/datasets?snapshot=${snapshot}`,
      "/api/dataset-deltas",
      `/api/dataset-deltas?snapshot=${snapshot}`,
    ]) {
      const response = await fetch(path);
      expect(response.status, path).toBe(200);
      const body = await response.text();
      const etag = response.headers.get("ETag") ?? "";
      expect(etag, path).toBe(`"${await sha256(body)}"`);
      expect(response.headers.get("Content-Type"), path).toBe(
        "application/json",
      );
      for (const validator of [
        etag,
        `W/${etag}`,
        `${unrelatedTag}, ${etag}`,
        "*",
      ]) {
        const revalidated = await fetch(path, {
          headers: { "If-None-Match": validator },
        });
        const label = `${path} ${validator}`;
        expect(revalidated.status, label).toBe(304);
        expect(await revalidated.text(), label).toBe("");
        expect(revalidated.headers.get("ETag"), label).toBe(etag);
        expect(revalidated.headers.get("Cache-Control"), label).toBe(
          "public, no-cache, must-revalidate",
        );
        expect(revalidated.headers.get("X-Dataset-Snapshot"), label).toBe(
          snapshot,
        );
      }
      const different = await fetch(path, {
        headers: { "If-None-Match": unrelatedTag },
      });
      expect(different.status, path).toBe(200);
      expect(await different.text(), path).toBe(body);
      const head = await fetch(path, { method: "HEAD" });
      expect(head.status, path).toBe(200);
      expect(head.headers.get("ETag"), path).toBe(etag);
      expect(head.headers.get("X-Dataset-Snapshot"), path).toBe(snapshot);
      expect(await head.text(), path).toBe("");
      expect(
        (
          await fetch(path, {
            method: "HEAD",
            headers: { "If-None-Match": etag },
          })
        ).status,
        path,
      ).toBe(304);
      const replaced = await fetch(path, {}, changed);
      expect(replaced.status, path).toBe(200);
      expect(replaced.headers.get("ETag"), path).not.toBe(etag);
      expect(
        (
          await fetch(path, {
            headers: { Origin: "https://consumer.example" },
          })
        ).headers
          .get("Access-Control-Expose-Headers")
          ?.split(/,\s*/u),
        path,
      ).toContain("ETag");
    }

    for (const listing of ["/api/datasets", "/api/dataset-deltas"])
      for (const [pin, status] of [
        ["0".repeat(64), 409],
        ["x", 400],
        [`${snapshot}&snapshot=${snapshot}`, 400],
      ] as const) {
        const path = `${listing}?snapshot=${pin}`;
        const refused = await fetch(path, {
          headers: { "If-None-Match": "*" },
        });
        expect(refused.status, path).toBe(status);
        expect(refused.headers.get("ETag"), path).toBeNull();
        expect(refused.headers.get("X-Dataset-Snapshot"), path).toBe(snapshot);
        expect(v.parse(ProblemSchema, await refused.json()).code, path).toBe(
          status === 409 ? "snapshot_changed" : "invalid_query",
        );
      }
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
      "limit=31",
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
  it("serves no retired public API route", async () => {
    for (const path of [
      "/api",
      "/api/openapi.json",
      "/api/contacts.vcf",
      "/api/v1",
      "/api/v1/datasets",
      "/api/v1/dataset-deltas",
      "/api/v1/openapi.json",
      "/api/v1/contacts",
      "/api/v1/contacts.vcf",
      "/api/v1/contact-groups",
      "/api/v1/catalog",
      "/api/v1/sources",
      "/api/v1/contacts/fixture:000",
      "/api/v1/search-index",
    ]) {
      const response = await request(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("Content-Type"), path).toContain(
        "application/problem+json",
      );
    }
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
      "limit=31",
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
    ]) {
      let path: string | null = start;
      for (let index = 0; path; index += 1) {
        const response = await served(path);
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
    ]) {
      const response = await served(path);
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
  it("supports HEAD and cache revalidation on the site routes and preflight only on open data", async () => {
    const response = await request("/api/catalog");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const etag = response.headers.get("ETag");
    if (!etag) throw new Error("Catalog validator missing");
    expect(
      (await request("/api/catalog", { headers: { "If-None-Match": etag } }))
        .status,
    ).toBe(304);
    expect(
      await (await request("/api/catalog", { method: "HEAD" })).text(),
    ).toBe("");
    const preflight = {
      method: "OPTIONS",
      headers: {
        Origin: "https://consumer.example",
        "Access-Control-Request-Method": "GET",
      },
    };
    const refused = await request("/api/catalog", preflight);
    expect(refused.status).toBe(405);
    expect(refused.headers.get("Allow")).toBe("GET, HEAD");
    expect(refused.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const admitted = await request("/api/datasets", preflight);
    expect(admitted.status).toBe(204);
    expect(admitted.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const posted = await request("/api/datasets", { method: "POST" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect((await request("/api/contacts", { method: "POST" })).status).toBe(
      405,
    );
  });
});

describe("site and open-data route families", () => {
  const senders = [
    undefined,
    "same-origin",
    "same-site",
    "cross-site",
    "none",
  ] as const;
  const siteRoutes = [
    "/api/catalog",
    "/api/contacts?q=図書館",
    "/api/contact-groups?q=図書館",
    "/api/contacts/fixture:000",
    "/api/contacts/fixture:000/contact.vcf",
    "/api/sources",
    `/api/contacts/row/${snapshot}/0`,
  ];
  const openDataFile = `/api/datasets/${snapshot}/${"3".repeat(64)}/contacts.csv.gz`;

  beforeAll(async () => {
    const bucket = await runtime.getR2Bucket("DATASETS");
    await bucket.put(openDataFile.replace("/api/datasets/", ""), "fixture\n");
  });

  async function sent(
    path: string,
    sender: (typeof senders)[number],
  ): Promise<Response> {
    return request(
      path,
      sender === undefined
        ? undefined
        : { headers: { "Sec-Fetch-Site": sender } },
    );
  }

  it("refuses site routes to every sender but this origin and serves open data to all", async () => {
    for (const sender of senders)
      for (const [family, path] of [
        ["site", "/api/catalog"],
        ["open-data", openDataFile],
      ] as const) {
        const response = await sent(path, sender);
        const label = `${family} ${String(sender)}`;
        const refused =
          family === "site" && sender !== undefined && sender !== "same-origin";
        expect(response.status, label).toBe(refused ? 403 : 200);
        expect(response.headers.get("Access-Control-Allow-Origin"), label).toBe(
          family === "site" ? null : "*",
        );
        if (refused) {
          const body: unknown = await response.json();
          expect(v.parse(ProblemSchema, body).code, label).toBe("cross_origin");
          expect(response.headers.get("Content-Type"), label).toContain(
            "application/problem+json",
          );
        }
      }
  });

  it("answers every site route to this origin without cross-origin headers", async () => {
    for (const path of siteRoutes) {
      for (const sender of [undefined, "same-origin"] as const) {
        const response = await sent(path, sender);
        expect(response.status, `${path} ${String(sender)}`).toBe(200);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
        expect(
          response.headers.get("Access-Control-Expose-Headers"),
        ).toBeNull();
      }
      for (const sender of ["cross-site", "same-site", "none"] as const)
        expect((await sent(path, sender)).status, `${path} ${sender}`).toBe(
          403,
        );
    }
    const missing = await request("/api/missing");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("sends each path to exactly one route family", () => {
    for (const [path, open] of [
      ["/api/v1", false],
      ["/api/v1/datasets", false],
      ["/api/v1/dataset-deltas", false],
      [`/api/v1/datasets/${snapshot}/${snapshot}/contacts.csv.gz`, false],
      ["/api/v1/contacts", false],
      ["/api/datasets", true],
      [`/api/datasets/${snapshot}/${snapshot}/contacts.csv.gz`, true],
      ["/api/dataset-deltas", true],
      ["/api", false],
      ["/api/v10", false],
      ["/api/datasets-old", false],
      ["/api/dataset-deltas/x", false],
      ["/api/catalog", false],
      ["/api/contacts", false],
      ["/api/search-index", false],
      ["/api/contacts.vcf", false],
    ] as const)
      expect(openDataPath(path), path).toBe(open);
  });
});

describe("website search index and row locator", () => {
  const indexText = "public-phonebook-search-index\t1\n{}\n";
  const indexBytes = brotliCompressSync(indexText);
  const indexSha256 = createHash("sha256").update(indexBytes).digest("hex");
  const indexUrl = `/api/search-index/${snapshot}/${indexSha256}`;
  const otherSnapshot = "2".repeat(64);
  let production: DirectoryApiBindings;

  async function prepared(
    searchIndex: Record<string, unknown>,
  ): Promise<string> {
    const manifest = JSON.stringify({
      snapshot,
      generatedAt: "2026-10-30T00:00:00Z",
      contacts: contacts.length,
      phones: 1,
      sourceCount: 1,
      sourceDatabaseSha256: "1".repeat(64),
      databaseSha256: "2".repeat(64),
      files: [
        "contacts.jsonl.gz",
        "contacts.csv.gz",
        "contacts.vcf.gz",
        "directory.tsv.br",
      ].map((file) => ({
        file,
        sha256: "3".repeat(64),
        bytes: 1,
        url: `/api/datasets/${snapshot}/${"3".repeat(64)}/${file}`,
      })),
      searchIndex: { file: "search-index.br", ...searchIndex },
    });
    const digest = await sha256(manifest);
    const bucket = await runtime.getR2Bucket("DATASETS");
    await bucket.put(manifestObjectKey(snapshot, digest), manifest);
    return digest;
  }

  async function serve(
    path: string,
    init?: RequestInit,
    environment: DirectoryApiBindings = production,
  ): Promise<Response> {
    return api.fetch(
      new Request(`https://www.dial.page${path}`, init),
      environment,
    );
  }

  async function problemCode(response: Response): Promise<string> {
    const body: unknown = await response.json();
    return v.parse(ProblemSchema, body).code;
  }

  beforeAll(async () => {
    const bucket = await runtime.getR2Bucket("DATASETS");
    await bucket.put(searchIndexObjectKey(snapshot, indexSha256), indexBytes);
    production = {
      ...bindings,
      APP_ENV: "production",
      DATASET_MANIFEST_SHA256: await prepared({
        sha256: indexSha256,
        bytes: indexBytes.byteLength,
        uncompressedSha256: createHash("sha256")
          .update(indexText)
          .digest("hex"),
        uncompressedBytes: new TextEncoder().encode(indexText).byteLength,
      }),
    };
  });

  it("locates the current index with a revalidated discovery response", async () => {
    const response = await serve("/api/search-index");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(v.parse(SearchIndexLocationSchema, body)).toEqual({
      snapshot,
      url: indexUrl,
      sha256: indexSha256,
      bytes: indexBytes.byteLength,
      uncompressedSha256: createHash("sha256").update(indexText).digest("hex"),
      uncompressedBytes: new TextEncoder().encode(indexText).byteLength,
    });
    expect(response.headers.get("Cache-Control")).toBe(
      "public, no-cache, must-revalidate",
    );
    expect(response.headers.get("X-Dataset-Snapshot")).toBe(snapshot);
    const etag = response.headers.get("ETag");
    if (!etag) throw new Error("The index location validator is missing");
    for (const validator of [etag, `W/${etag}`, `"other", ${etag}`]) {
      const revalidated = await serve("/api/search-index", {
        headers: { "If-None-Match": validator },
      });
      expect(revalidated.status, validator).toBe(304);
      expect(await revalidated.text()).toBe("");
    }
    const unbound = await serve("/api/search-index", undefined, {
      ...production,
      DATASET_MANIFEST_SHA256: "",
    });
    expect(unbound.status).toBe(503);
    expect((await serve("/api/search-index?snapshot=x")).status).toBe(400);
    expect((await serve("/api/v1/search-index")).status).toBe(404);
  });

  it("returns the stored Brotli bytes with immutable validators", async () => {
    const response = await serve(indexUrl, {
      headers: { "Accept-Encoding": "gzip, deflate, br, zstd" },
    });
    expect(response.status).toBe(200);
    for (const [header, value] of [
      ["Content-Encoding", "br"],
      ["Content-Type", "application/octet-stream"],
      ["Content-Length", String(indexBytes.byteLength)],
      ["ETag", `"${indexSha256}"`],
      ["Cache-Control", "public, max-age=31536000, immutable"],
      ["Vary", "Accept-Encoding"],
      ["X-Dataset-Snapshot", snapshot],
      ["X-Content-Type-Options", "nosniff"],
    ] as const)
      expect(response.headers.get(header), header).toBe(value);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(indexSha256);
    const head = await serve(indexUrl, {
      method: "HEAD",
      headers: { "Accept-Encoding": "br" },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Encoding")).toBe("br");
    expect(await head.text()).toBe("");
    for (const validator of [`"${indexSha256}"`, `W/"${indexSha256}"`, "*"]) {
      const cached = await serve(indexUrl, {
        headers: { "Accept-Encoding": "br", "If-None-Match": validator },
      });
      expect(cached.status, validator).toBe(304);
      expect(cached.headers.get("ETag")).toBe(`"${indexSha256}"`);
      expect(cached.headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(cached.headers.get("Content-Encoding")).toBeNull();
      expect(await cached.text()).toBe("");
    }
  });

  it("refuses an index request that doesn't admit Brotli", async () => {
    for (const encoding of [
      undefined,
      "",
      "identity",
      "gzip, deflate",
      "br;q=0",
      "*;q=0",
    ]) {
      const response = await serve(
        indexUrl,
        encoding === undefined
          ? undefined
          : { headers: { "Accept-Encoding": encoding } },
      );
      expect(response.status, String(encoding)).toBe(406);
      expect(await problemCode(response)).toBe("not_acceptable");
      expect(response.headers.get("Vary")).toBe("Accept-Encoding");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("hides bytes that aren't the current snapshot's index", async () => {
    const accepted = { headers: { "Accept-Encoding": "br" } };
    for (const path of [
      `/api/search-index/${snapshot}/${"5".repeat(64)}`,
      `/api/search-index/${otherSnapshot}/${indexSha256}`,
      `/api/search-index/${snapshot}/${indexSha256.toUpperCase()}`,
      `/api/search-index/abc/${indexSha256}`,
      `${indexUrl}/search-index.br`,
    ]) {
      const response = await serve(path, accepted);
      expect(response.status, path).toBe(404);
      expect(await problemCode(response)).toBe("not_found");
    }
    expect((await serve(`${indexUrl}?format=1`, accepted)).status).toBe(400);
    const missing = "7".repeat(64);
    const unstored = await serve(
      `/api/search-index/${snapshot}/${missing}`,
      accepted,
      {
        ...production,
        DATASET_MANIFEST_SHA256: await prepared({
          sha256: missing,
          bytes: 1,
          uncompressedSha256: missing,
          uncompressedBytes: 1,
        }),
      },
    );
    expect(unstored.status).toBe(503);
    const mismatched = await serve(indexUrl, accepted, {
      ...production,
      DATASET_MANIFEST_SHA256: await prepared({
        sha256: indexSha256,
        bytes: indexBytes.byteLength + 1,
        uncompressedSha256: missing,
        uncompressedBytes: 1,
      }),
    });
    expect(mismatched.status).toBe(503);
  });

  it("returns only the contact ID of a current row", async () => {
    for (const [row, id] of [
      [0, "fixture:000"],
      [172, "fixture:172"],
    ] as const) {
      const response = await serve(`/api/contacts/row/${snapshot}/${row}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe(JSON.stringify({ id }));
      expect(v.parse(RowLocationSchema, JSON.parse(text)).id).toBe(id);
      expect(response.headers.get("X-Dataset-Snapshot")).toBe(snapshot);
      expect(response.headers.get("Cache-Control")).toBe(
        "public, no-cache, must-revalidate",
      );
    }
    const head = await serve(`/api/contacts/row/${snapshot}/0`, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("separates stale snapshots, missing rows, and malformed locators", async () => {
    const stale = await serve(`/api/contacts/row/${otherSnapshot}/0`);
    expect(stale.status).toBe(409);
    expect(await problemCode(stale)).toBe("snapshot_changed");
    expect(stale.headers.get("X-Dataset-Snapshot")).toBe(snapshot);
    for (const row of [String(contacts.length), "9007199254740991"]) {
      const missing = await serve(`/api/contacts/row/${snapshot}/${row}`);
      expect(missing.status, row).toBe(404);
      expect(await problemCode(missing)).toBe("not_found");
    }
    for (const path of [
      `abc/0`,
      `${"A".repeat(64)}/0`,
      `${snapshot}/01`,
      `${snapshot}/-1`,
      `${snapshot}/%2B1`,
      `${snapshot}/1.0`,
      `${snapshot}/1e3`,
      `${snapshot}/%201`,
      `${snapshot}/9007199254740992`,
      `${otherSnapshot}/01`,
      `${snapshot}/0?row=0`,
    ]) {
      const malformed = await serve(`/api/contacts/row/${path}`);
      expect(malformed.status, path).toBe(400);
      expect(await problemCode(malformed)).toBe("invalid_query");
    }
  });

  it("serves the index and its location only to this origin", async () => {
    for (const path of ["/api/search-index", indexUrl]) {
      const response = await serve(path, {
        headers: { "Accept-Encoding": "br", "Sec-Fetch-Site": "cross-site" },
      });
      expect(response.status, path).toBe(403);
      expect(await problemCode(response)).toBe("cross_origin");
      const admitted = await serve(path, {
        headers: { "Accept-Encoding": "br", "Sec-Fetch-Site": "same-origin" },
      });
      expect(admitted.status, path).toBe(200);
      expect(admitted.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
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
    for (const path of ["/api/catalog", "/api/contacts/fixture:000"])
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
