import { createHash } from "node:crypto";
import { get } from "node:http";
import { brotliDecompressSync } from "node:zlib";
import { Miniflare } from "miniflare";
import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  categoryDefinitions,
  prefectureNames,
} from "../../src/core/catalog.ts";
import {
  datasetFileListing,
  PreparedDatasetManifestSchema,
  SearchIndexLocationSchema,
} from "../../src/core/dataset-storage.ts";
import { httpStatus } from "../../src/core/http-status.ts";
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
import { apiWorkerEntry, bundledApi } from "./workerd-fixture.ts";

const fixtureOrigin = "http://localhost:8787";
const prefectureCodeWidth = 2;
const fixturePrefecture = "13";
const digestLength = 64;
const fixtureNames = ["図書館", "市役所", "公民館", "体育館", "美術館"];
const archiveLength = 1000;
const byteValues = 256;
const byteStride = 7;
const archiveBytes = Uint8Array.from(
  { length: archiveLength },
  (_, position) => (position * byteStride) % byteValues,
);

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
const archiveKey = `${snapshot}/${"c".repeat(digestLength)}/directory.tsv.br`;
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
              "worker.js": { type: "esm", contents: apiWorkerEntry },
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
  await bucket.put(archiveKey, archiveBytes);
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
      JSON.stringify(datasetFileListing(manifest)),
    );
  });

  it("answers byte ranges of a dataset file from R2", async () => {
    const path = `/api/${archiveKey.replace(`${snapshot}/`, `datasets/${snapshot}/`)}`;
    const whole = await request(path);
    expect(whole.status).toBe(httpStatus.ok);
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(whole.headers["content-length"]).toBe(String(archiveLength));
    expect(whole.body).toEqual(archiveBytes);
    const etag = String(whole.headers.etag);
    for (const [range, served] of [
      ["bytes=100-199", "bytes 100-199/1000"],
      ["bytes=900-", "bytes 900-999/1000"],
      ["bytes=990-5000", "bytes 990-999/1000"],
      ["bytes=-100", "bytes 900-999/1000"],
      ["bytes=-5000", "bytes 0-999/1000"],
    ] as const) {
      const response = await request(path, { Range: range });
      const [first, last] = servedBytes(served);
      expect(response.status, range).toBe(httpStatus.partialContent);
      expect(response.headers["content-range"], range).toBe(served);
      expect(response.headers["content-length"], range).toBe(
        String(last - first + 1),
      );
      expect(response.headers["accept-ranges"], range).toBe("bytes");
      expect(response.headers.etag, range).toBe(etag);
      expect(response.headers["x-dataset-snapshot"], range).toBe(snapshot);
      expect(response.body, range).toEqual(archiveBytes.slice(first, last + 1));
    }
    for (const range of ["bytes=1000-", "bytes=-0"]) {
      const response = await request(path, { Range: range });
      expect(response.status, range).toBe(httpStatus.rangeNotSatisfiable);
      expect(response.headers["content-range"], range).toBe("bytes */1000");
      expect(response.body.byteLength, range).toBe(0);
    }
    for (const range of [
      "bytes=abc",
      "bytes=5-2",
      "items=0-1",
      "bytes=0-1,5-6",
    ]) {
      const response = await request(path, { Range: range });
      expect(response.status, range).toBe(httpStatus.ok);
      expect(response.body, range).toEqual(archiveBytes);
    }
    const ranged = { Range: "bytes=100-199" };
    expect(
      (await request(path, { ...ranged, "If-Range": '"another"' })).status,
    ).toBe(httpStatus.ok);
    expect((await request(path, { ...ranged, "If-Range": etag })).status).toBe(
      httpStatus.partialContent,
    );
    expect(
      (await request(path, { ...ranged, "If-None-Match": etag })).status,
    ).toBe(httpStatus.notModified);
    const missing = path.replace("directory.tsv.br", "contacts.csv.gz");
    expect((await request(missing, ranged)).status).toBe(httpStatus.notFound);
  });
});

/** The first and last byte that a `Content-Range` value names. */
function servedBytes(value: string): readonly [number, number] {
  const [first = "", last = ""] = value
    .slice("bytes ".length, value.indexOf("/"))
    .split("-");
  return [Number(first), Number(last)];
}
