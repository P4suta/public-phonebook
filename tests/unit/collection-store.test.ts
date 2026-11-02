import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContactSchema, SourceSchema } from "../../src/core/models.ts";
import type { SourceArtifact } from "../../tools/collection/artifacts.ts";
import {
  encodeCollectionReport,
  fileIdentity,
} from "../../tools/collection/report.ts";
import {
  type BaseDatasetPin,
  BaseDatasetPinSchema,
  fetchBaseDatabase,
  parseCollectionStoreArguments,
  readBasePin,
  requireIdenticalCollections,
  storeCollection,
} from "../../tools/collection-store.ts";
import {
  type ControlStore,
  controlKeys,
  fileControlStore,
  writeOnce,
} from "../../tools/control-store.ts";

const encoder = new TextEncoder();
const digest = (text: string | Uint8Array): string =>
  createHash("sha256").update(text).digest("hex");
const baseDatabase = "base database bytes";
const baseManifest = JSON.stringify({
  databaseSha256: digest(baseDatabase),
  contacts: 2,
});
const pin: BaseDatasetPin = {
  manifestSha256: digest(baseManifest),
  database: {
    key: controlKeys.blob(digest(baseDatabase)),
    sha256: digest(baseDatabase),
    bytes: baseDatabase.length,
  },
};
const retrievedAt = "2026-11-02T00:00:00Z";
const sourceBytes = {
  "https://example.go.jp/schools.csv":
    "学校名,電話番号\n例小学校,03-3581-2331\n",
  "https://example.go.jp/schools.html": "<a href=schools.csv>schools</a>",
  "https://example.go.jp/terms": "CC BY 4.0",
};
const artifacts: SourceArtifact[] = Object.entries(sourceBytes).map(
  ([url, text]) => ({
    url,
    resolvedUrl: url,
    sha256: digest(text),
    bytes: encoder.encode(text).byteLength,
    retrievedAt,
    checkedAt: retrievedAt,
    etag: null,
    lastModified: null,
    contentType: "text/plain",
  }),
);
const source = v.parse(SourceSchema, {
  id: "schools:0123",
  publisher: "例市",
  url: "https://example.go.jp/schools.csv",
  sha256: digest(sourceBytes["https://example.go.jp/schools.csv"]),
  dataAsOf: "2026-10-01",
  retrievedAt,
  indexUrl: "https://example.go.jp/schools.html",
  indexSha256: digest(sourceBytes["https://example.go.jp/schools.html"]),
  licenseUrl: "https://example.go.jp/terms",
  licenseSha256: digest(sourceBytes["https://example.go.jp/terms"]),
  artifacts: artifacts.map(({ url, sha256 }) => ({
    url,
    sha256,
    retrievedAt,
  })),
  rows: 1,
  accepted: 1,
  missingPhone: 0,
  invalid: 0,
  duplicate: 0,
  issues: {},
});
const contact = v.parse(ContactSchema, {
  id: "school:example",
  name: "例小学校",
  category: "elementary_school",
  prefectureCode: "13",
  municipalityCode: null,
  address: "東京都千代田区1-2-3",
  phones: [{ display: "03-3581-2331", e164: "+81335812331" }],
  website: null,
  sourceId: source.id,
  sourceRecordId: "1",
  sourceUrls: [source.url],
  license: "CC BY 4.0",
  licenseUrl: "https://example.go.jp/terms",
  dataAsOf: "2026-10-01",
  retrievedAt,
  phoneConfirmed: false,
  phoneConfirmationUrl: null,
});
const datasetFiles = {
  "contacts.csv.gz": "csv archive",
  "search-index.br": "index bytes",
  "directory.sqlite": "prepared database",
};

let root = "";
let store: ControlStore;
let collection = "";
let cache = "";
let dataset = "";

async function writeCollection(
  directory: string,
  listed: readonly SourceArtifact[] = artifacts,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const outputs = {
    "contacts.jsonl": encoder.encode(`${JSON.stringify(contact)}\n`),
    "sources.json": encoder.encode(`${JSON.stringify([source], null, 2)}\n`),
    "artifacts.json": encoder.encode(`${JSON.stringify(listed, null, 2)}\n`),
  };
  for (const [file, bytes] of Object.entries(outputs))
    await writeFile(join(directory, file), bytes);
  const report = encodeCollectionReport(
    {
      registrySchools: 1,
      contacts: 1,
      conflicts: [],
      coverage: new Map([["13:elementary_school", 1]]),
      plans: [
        {
          plan: "schools",
          source: source.id,
          contacts: 1,
          rows: 1,
          missingPhone: 0,
          invalid: 0,
          duplicate: 0,
          issues: {},
          unmatched: [],
        },
      ],
      failures: [],
    },
    {
      "contacts.jsonl": fileIdentity(outputs["contacts.jsonl"]),
      "sources.json": fileIdentity(outputs["sources.json"]),
      "artifacts.json": fileIdentity(outputs["artifacts.json"]),
    },
  );
  await writeFile(join(directory, "collection-report.json"), report);
  return digest(report);
}

async function writeDataset(
  directory: string,
  sourceDatabaseSha256: string = pin.database.sha256,
  contacts = 3,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const manifest = JSON.stringify({
    snapshot: "1".repeat(64),
    sourceDatabaseSha256,
    contacts,
    databaseSha256: digest(datasetFiles["directory.sqlite"]),
    files: [
      {
        file: "contacts.csv.gz",
        sha256: digest(datasetFiles["contacts.csv.gz"]),
        bytes: datasetFiles["contacts.csv.gz"].length,
      },
    ],
    searchIndex: {
      file: "search-index.br",
      sha256: digest(datasetFiles["search-index.br"]),
      bytes: datasetFiles["search-index.br"].length,
    },
  });
  await writeFile(join(directory, "manifest.ready.json"), manifest);
  await writeFile(join(directory, "catalog.json"), '{"catalog":1}');
  for (const [name, text] of Object.entries(datasetFiles))
    await writeFile(join(directory, name), text);
  return digest(manifest);
}

async function storedKeys(): Promise<readonly string[]> {
  const location = join(root, "store");
  return (await readdir(location, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(location, join(entry.parentPath, entry.name)))
    .sort();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "phonebook-collection-store-"));
  store = fileControlStore(join(root, "store"));
  await store.write(pin.database.key, encoder.encode(baseDatabase), {
    kind: "create",
  });
  await writeOnce(
    store,
    controlKeys.dataset(pin.manifestSha256, "manifest.ready.json"),
    encoder.encode(baseManifest),
  );
  collection = join(root, "collection");
  cache = join(root, "cache");
  dataset = join(root, "dataset");
  await mkdir(join(cache, "objects"), { recursive: true });
  for (const text of Object.values(sourceBytes))
    await writeFile(join(cache, "objects", digest(text)), text);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("collection store arguments", () => {
  it("parses the base, compare, and store commands and refuses anything else", () => {
    expect(parseCollectionStoreArguments(["base", "target"])).toEqual({
      kind: "base",
      directory: resolve("target"),
    });
    expect(parseCollectionStoreArguments(["compare", "a", "b"])).toEqual({
      kind: "compare",
      collection: resolve("a"),
      replay: resolve("b"),
    });
    expect(parseCollectionStoreArguments(["store", "a", "b", "c"])).toEqual({
      kind: "store",
      collection: resolve("a"),
      cache: resolve("b"),
      dataset: resolve("c"),
    });
    for (const args of [
      [],
      ["base"],
      ["base", "a", "b"],
      ["compare", "a"],
      ["store", "a", "b"],
      ["upload", "a"],
    ])
      expect(() => parseCollectionStoreArguments(args), args.join(" ")).toThrow(
        "Usage",
      );
  });
});

describe("base dataset pin", () => {
  it("pins the repository base by its manifest, database digest, size, and blob key", async () => {
    const repositoryPin = await readBasePin();
    expect(repositoryPin.database.key).toBe(
      controlKeys.blob(repositoryPin.database.sha256),
    );
    expect(
      v.is(BaseDatasetPinSchema, {
        ...pin,
        database: { ...pin.database, key: controlKeys.blob("2".repeat(64)) },
      }),
    ).toBe(false);
    expect(
      v.is(BaseDatasetPinSchema, {
        ...pin,
        database: { ...pin.database, bytes: 0 },
      }),
    ).toBe(false);
  });

  it("downloads the pinned base database and refuses one that differs from the pin", async () => {
    const target = join(root, "base");
    const path = await fetchBaseDatabase(store, pin, target);
    expect(await readFile(path, "utf8")).toBe(baseDatabase);
    await expect(
      fetchBaseDatabase(
        store,
        {
          ...pin,
          database: { ...pin.database, bytes: pin.database.bytes + 1 },
        },
        target,
      ),
    ).rejects.toThrow("differs from its pin");
    await writeFile(
      join(root, "store", ...pin.database.key.split("/")),
      "tampered base database",
    );
    await expect(fetchBaseDatabase(store, pin, target)).rejects.toThrow(
      "differs from its pin",
    );
    await expect(readFile(path)).rejects.toThrow("ENOENT");
  });

  it("refuses a base whose manifest is missing, differs, or names another database", async () => {
    const target = join(root, "base");
    await expect(
      fetchBaseDatabase(
        store,
        { ...pin, manifestSha256: "3".repeat(64) },
        target,
      ),
    ).rejects.toThrow("no manifest for the base dataset");
    const otherDatabase = "other database";
    const otherManifest = JSON.stringify({
      databaseSha256: digest(otherDatabase),
      contacts: 2,
    });
    await writeOnce(
      store,
      controlKeys.dataset(digest(otherManifest), "manifest.ready.json"),
      encoder.encode(otherManifest),
    );
    await expect(
      fetchBaseDatabase(
        store,
        { ...pin, manifestSha256: digest(otherManifest) },
        target,
      ),
    ).rejects.toThrow("names another database");
    await writeFile(
      join(
        root,
        "store",
        ...controlKeys
          .dataset(pin.manifestSha256, "manifest.ready.json")
          .split("/"),
      ),
      "{}",
    );
    await expect(fetchBaseDatabase(store, pin, target)).rejects.toThrow(
      "manifest differs from its pin",
    );
  });

  it("refuses a pinned database that the control store doesn't hold", async () => {
    const missing = "missing database";
    const manifest = JSON.stringify({
      databaseSha256: digest(missing),
      contacts: 2,
    });
    await writeOnce(
      store,
      controlKeys.dataset(digest(manifest), "manifest.ready.json"),
      encoder.encode(manifest),
    );
    await expect(
      fetchBaseDatabase(
        store,
        {
          manifestSha256: digest(manifest),
          database: {
            key: controlKeys.blob(digest(missing)),
            sha256: digest(missing),
            bytes: missing.length,
          },
        },
        join(root, "base"),
      ),
    ).rejects.toThrow("no base database");
  });
});

describe("offline replay comparison", () => {
  it("accepts identical outputs and names every file that differs", async () => {
    await writeCollection(collection);
    const replay = join(root, "replay");
    await writeCollection(replay);
    await requireIdenticalCollections(collection, replay);
    await writeCollection(replay, artifacts.toReversed());
    await expect(
      requireIdenticalCollections(collection, replay),
    ).rejects.toThrow("artifacts.json, collection-report.json");
  });
});

describe("collection storage", () => {
  it("stores the source bytes, the collection, and the dataset under write-once keys", async () => {
    const report = await writeCollection(collection);
    const manifestSha256 = await writeDataset(dataset);
    const before = await storedKeys();
    const input = { collection, cache, dataset, pin };
    expect(await storeCollection(store, input)).toEqual({
      report,
      manifestSha256,
      contacts: 3,
      artifacts: artifacts.length,
    });
    expect((await storedKeys()).filter((key) => !before.includes(key))).toEqual(
      [
        ...artifacts.map((artifact) =>
          controlKeys.collectionCache(artifact.sha256),
        ),
        ...[
          "artifacts.json",
          "collection-report.json",
          "contacts.jsonl",
          "dataset.json",
          "sources.json",
        ].map((file) => controlKeys.collection(report, file)),
        ...Object.values(datasetFiles).map((text) =>
          controlKeys.blob(digest(text)),
        ),
        controlKeys.dataset(manifestSha256, "catalog.json"),
        controlKeys.dataset(manifestSha256, "manifest.ready.json"),
      ].sort(),
    );
    const link: unknown = JSON.parse(
      await readFile(
        join(
          root,
          "store",
          ...controlKeys.collection(report, "dataset.json").split("/"),
        ),
        "utf8",
      ),
    );
    expect(link).toEqual({
      formatVersion: 1,
      report,
      base: {
        manifestSha256: pin.manifestSha256,
        databaseSha256: pin.database.sha256,
      },
      manifestSha256,
    });
    const stored = await storedKeys();
    expect(await storeCollection(store, input)).toEqual(
      await storeCollection(store, input),
    );
    expect(await storedKeys()).toEqual(stored);
  });

  it("refuses a collection file that differs from its report before writing", async () => {
    await writeCollection(collection);
    await writeDataset(dataset);
    const before = await storedKeys();
    await writeFile(join(collection, "contacts.jsonl"), "{}\n");
    await expect(
      storeCollection(store, { collection, cache, dataset, pin }),
    ).rejects.toThrow("differs from its report: contacts.jsonl");
    expect(await storedKeys()).toEqual(before);
  });

  it("refuses a tampered cache object and a cited artifact the collection doesn't list", async () => {
    await writeCollection(collection);
    await writeDataset(dataset);
    const before = await storedKeys();
    const first = artifacts[0];
    if (!first) throw new Error("Missing fixture artifact");
    await writeFile(join(cache, "objects", first.sha256), "tampered");
    await expect(
      storeCollection(store, { collection, cache, dataset, pin }),
    ).rejects.toThrow("integrity failure");
    await writeFile(
      join(cache, "objects", first.sha256),
      sourceBytes["https://example.go.jp/schools.csv"],
    );
    await writeCollection(collection, artifacts.slice(1));
    await expect(
      storeCollection(store, { collection, cache, dataset, pin }),
    ).rejects.toThrow("lacks a cited source artifact");
    await writeCollection(collection, [...artifacts, first]);
    await expect(
      storeCollection(store, { collection, cache, dataset, pin }),
    ).rejects.toThrow("lists a source URL twice");
    expect(await storedKeys()).toEqual(before);
  });

  it("refuses a dataset prepared from another base or without exactly the collected contacts", async () => {
    await writeCollection(collection);
    const before = await storedKeys();
    await writeDataset(dataset, "4".repeat(64));
    await expect(
      storeCollection(store, { collection, cache, dataset, pin }),
    ).rejects.toThrow("wasn't prepared from the pinned base database");
    await rm(dataset, { recursive: true });
    await writeDataset(dataset, pin.database.sha256, 2);
    await expect(
      storeCollection(store, { collection, cache, dataset, pin }),
    ).rejects.toThrow("exactly the base and collection contacts");
    expect(await storedKeys()).toEqual(before);
  });
});
