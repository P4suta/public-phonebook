import { createHash } from "node:crypto";
import { get } from "node:http";
import { brotliDecompressSync } from "node:zlib";
import { Miniflare } from "miniflare";
import * as v from "valibot";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  categoryDefinitions,
  prefectureNames,
} from "../../src/core/catalog.ts";
import {
  PreparedDatasetManifestSchema,
  publicDatasetManifest,
  SearchIndexLocationSchema,
} from "../../src/core/dataset-storage.ts";
import { normalizeName } from "../../src/core/identity.ts";
import {
  CatalogSchema,
  type Contact,
  ContactSchema,
  RowLocationSchema,
} from "../../src/core/models.ts";
import {
  decodeSearchIndex,
  encodeSearchIndex,
  searchIndexFile,
  searchIndexRow,
} from "../../src/core/search-index.ts";
import { databaseSchema } from "../../tools/database-schema.ts";
import { compressSearchIndex } from "../../tools/search-index.ts";
import { contactRowNumbers } from "../../tools/snapshot.ts";

const fixtureOrigin = "http://localhost:8787";
const prefectureCodeWidth = 2;
const fixturePrefecture = "13";
const digestLength = 64;
const fixtureNames = ["図書館", "市役所", "公民館", "体育館", "美術館"];
const workerEntry =
  "import { api } from './api.js'; export default { fetch: (request, env, context) => api.fetch(request, env, context) };";

interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Uint8Array;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Bundles the actual API module for workerd, so the runtime and not Node handles its responses. */
async function bundledApi(): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: "warn",
    ssr: { target: "webworker", noExternal: true },
    resolve: { conditions: ["workerd", "worker", "browser", "import"] },
    build: {
      write: false,
      ssr: "src/server/api.ts",
      minify: false,
      rollupOptions: { output: { format: "es", codeSplitting: false } },
    },
  });
  for (const result of Array.isArray(output) ? output : [output])
    if ("output" in result)
      for (const chunk of result.output)
        if (chunk.type === "chunk" && chunk.exports.includes("api"))
          return chunk.code;
  throw new Error("The API bundle has no entry chunk");
}

const contacts: Contact[] = fixtureNames.map((name, position) =>
  v.parse(ContactSchema, {
    id: `fixture:${position}`,
    name,
    category: position % 2 === 0 ? "library" : "medical",
    prefectureCode: fixturePrefecture,
    municipalityCode: "13101",
    address: "東京都千代田区永田町1-10-1",
    phones: [
      { display: `03-3581-233${position}`, e164: `+8133581233${position}` },
    ],
    website: null,
    sourceId: "fixture",
    sourceRecordId: String(position),
    sourceUrls: ["https://example.org/data"],
    license: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    dataAsOf: "2026-10-01",
    retrievedAt: "2026-10-29T00:00:00Z",
    phoneConfirmed: false,
    phoneConfirmationUrl: null,
  }),
);
const snapshot = sha256(
  contacts.map((contact) => `${JSON.stringify(contact)}\n`).join(""),
);
const catalog = v.parse(CatalogSchema, {
  snapshot,
  generatedAt: "2026-10-29T00:00:00Z",
  contacts: contacts.length,
  phones: contacts.length,
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
  prefectures: prefectureNames.map((name, position) => {
    const code = String(position + 1).padStart(prefectureCodeWidth, "0");
    return {
      code,
      name,
      contacts: code === fixturePrefecture ? contacts.length : 0,
    };
  }),
  municipalities: [
    { code: "13101", prefectureCode: fixturePrefecture, name: "千代田区" },
  ],
});
const rowNumbers = contactRowNumbers(contacts);
const index = encodeSearchIndex(
  contacts
    .toSorted(
      (left, right) =>
        (rowNumbers.get(left.id) ?? 0) - (rowNumbers.get(right.id) ?? 0),
    )
    .map((contact) => searchIndexRow(contact)),
  { snapshot, catalog },
);
const compressed = compressSearchIndex(index);
const manifest = v.parse(PreparedDatasetManifestSchema, {
  snapshot,
  generatedAt: catalog.generatedAt,
  contacts: contacts.length,
  phones: contacts.length,
  sourceCount: 1,
  sourceDatabaseSha256: "a".repeat(digestLength),
  databaseSha256: "b".repeat(digestLength),
  files: [
    "contacts.jsonl.gz",
    "contacts.csv.gz",
    "contacts.vcf.gz",
    "directory.tsv.br",
  ].map((file) => ({
    file,
    sha256: "c".repeat(digestLength),
    bytes: 1,
    url: `/api/datasets/${snapshot}/${"c".repeat(digestLength)}/${file}`,
  })),
  searchIndex: {
    file: searchIndexFile,
    sha256: sha256(compressed),
    bytes: compressed.byteLength,
    uncompressedSha256: sha256(index),
    uncompressedBytes: index.byteLength,
  },
});

let runtime: Miniflare | undefined;
let origin: URL | undefined;

beforeAll(async () => {
  runtime = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    enableDevRegistry: false,
    unsafeEnableSharedStorage: false,
    workers: [
      {
        config: {
          name: "workerd-api",
          compatibilityDate: "2026-10-23",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: workerEntry },
              "api.js": { type: "esm", contents: await bundledApi() },
            },
          },
          env: {
            DB: { type: "d1", id: "workerd-api" },
            DATASETS: { type: "r2", name: "workerd-api" },
            APP_ENV: { type: "text", value: "development" },
            PUBLIC_ORIGIN: { type: "text", value: fixtureOrigin },
          },
        },
      },
    ],
  });
  const DB = await runtime.getD1Database("DB");
  await DB.exec(databaseSchema.replaceAll("\n", " "));
  await DB.batch([
    ...contacts.map((contact) =>
      DB.prepare(
        "INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        rowNumbers.get(contact.id) ?? 0,
        contact.id,
        contact.name,
        normalizeName(contact.name),
        contact.prefectureCode,
        contact.municipalityCode,
        contact.category,
        contact.sourceId,
        JSON.stringify(contact),
      ),
    ),
    DB.prepare("INSERT INTO metadata VALUES ('catalog', ?)").bind(
      JSON.stringify(catalog),
    ),
  ]);
  const bucket = await runtime.getR2Bucket("DATASETS");
  await bucket.put(
    `${snapshot}/${manifest.searchIndex.sha256}/${searchIndexFile}`,
    compressed,
  );
  await bucket.put(`${snapshot}/manifest.json`, JSON.stringify(manifest));
  origin = await runtime.ready;
});

afterAll(async () => runtime?.dispose());

/** Reads the runtime's HTTP response with a client that doesn't decode content codings. */
function request(
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<RawResponse> {
  if (!origin) throw new Error("The workerd runtime isn't ready");
  const target = new URL(path, origin);
  return new Promise((resolve, reject) => {
    get(target, { headers }, (response) => {
      const chunks: Uint8Array[] = [];
      response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: concatenate(chunks),
        }),
      );
    }).on("error", reject);
  });
}

describe("API responses from workerd", () => {
  it("delivers the stored search index bytes with their Brotli coding unchanged", async () => {
    const discovery = await request("/api/search-index");
    expect(discovery.status).toBe(200);
    const location = v.parse(
      SearchIndexLocationSchema,
      JSON.parse(text(discovery.body)),
    );
    expect(location.sha256).toBe(sha256(compressed));
    const response = await request(location.url, {
      "Accept-Encoding": "gzip, br",
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.headers["content-length"]).toBe(
      String(compressed.byteLength),
    );
    expect(response.headers.etag).toBe(`"${location.sha256}"`);
    expect(response.body.byteLength).toBe(compressed.byteLength);
    expect(sha256(response.body)).toBe(sha256(compressed));
    const decoded = brotliDecompressSync(response.body);
    expect(sha256(decoded)).toBe(location.uncompressedSha256);
    expect(decoded.byteLength).toBe(location.uncompressedBytes);
    expect(
      (await request(location.url, { "Accept-Encoding": "gzip" })).status,
    ).toBe(406);
  });

  it("locates the contact of each index row and keeps the dataset listing byte-identical", async () => {
    for (const [row, entry] of decodeSearchIndex(index).rows.entries()) {
      const response = await request(`/api/contacts/row/${snapshot}/${row}`);
      expect(response.status).toBe(200);
      const { id } = v.parse(
        RowLocationSchema,
        JSON.parse(text(response.body)),
      );
      const contact = contacts.find((candidate) => candidate.id === id);
      expect(normalizeName(contact?.name ?? "")).toBe(entry.normalizedName);
    }
    expect(
      (await request(`/api/contacts/row/${snapshot}/${contacts.length}`))
        .status,
    ).toBe(404);
    const datasets = await request("/api/datasets");
    expect(datasets.status).toBe(200);
    expect(text(datasets.body)).toBe(
      JSON.stringify(publicDatasetManifest(manifest)),
    );
  });
});
