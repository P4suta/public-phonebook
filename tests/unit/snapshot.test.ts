import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import * as v from "valibot";
import { expect, it } from "vitest";
import {
  datasetFileListing,
  type PreparedDatasetManifest,
  PreparedDatasetManifestSchema,
} from "../../src/core/dataset-storage.ts";
import { decodeDirectoryArchive } from "../../src/core/directory-archive.ts";
import {
  applyDirectoryDelta,
  decodeDirectoryDelta,
} from "../../src/core/directory-delta.ts";
import {
  type Catalog,
  CatalogSchema,
  type Contact,
  ContactSchema,
  type Source,
  SourceSchema,
} from "../../src/core/models.ts";
import { nameTokens, normalizeName } from "../../src/core/search.ts";
import {
  decodeSearchIndex,
  encodeSearchIndex,
  searchIndexLimits,
} from "../../src/core/search-index.ts";
import { searchForm } from "../../src/core/search-text.ts";
import { checkDataBundle } from "../../tools/check-data.ts";
import {
  fetchDeltaBases,
  unservedShippedBases,
} from "../../tools/collection-store.ts";
import { fileControlStore } from "../../tools/control-store.ts";
import {
  deltaBaseDirectories,
  parsePrepareArguments,
} from "../../tools/data.ts";
import { databaseSchema } from "../../tools/database-schema.ts";
import {
  deltaSource as bundleDeltaSource,
  sha256Digest,
} from "../../tools/directory-delta.ts";
import { command } from "../../tools/process.ts";
import { storeDataset } from "../../tools/remote-data.ts";
import { compressSearchIndex } from "../../tools/search-index.ts";
import {
  compressDirectoryArchive,
  fileDigest,
  prepareSnapshot,
} from "../../tools/snapshot.ts";

it("prepares canonical native data with normalized addresses and complete archive accounting", async () => {
  const root = await mkdtemp(join(tmpdir(), "phonebook-snapshot-"));
  const path = join(root, "input.sqlite");
  const db = new DatabaseSync(path);
  const contact = v.parse(ContactSchema, {
    id: "school:example",
    name: "例小学校",
    category: "elementary_school",
    prefectureCode: "13",
    municipalityCode: "13101",
    address: "〒１００－０００１ 東京都千代田区一丁目２番３号（案内図）",
    phones: [{ display: "03-3581-2331", e164: "+81335812331" }],
    website: null,
    sourceId: "source",
    sourceRecordId: "1",
    sourceUrls: ["https://example.go.jp/"],
    license: "CC0",
    licenseUrl: "https://example.go.jp/terms",
    dataAsOf: "2026-10-01",
    retrievedAt: "2026-10-30T00:00:00Z",
    phoneConfirmed: false,
    phoneConfirmationUrl: null,
  });
  const source = v.parse(SourceSchema, {
    id: "source",
    url: "https://example.go.jp/data.csv",
    sha256: "a".repeat(64),
    dataAsOf: "2026-10-01",
    retrievedAt: contact.retrievedAt,
    indexUrl: null,
    indexSha256: null,
    licenseUrl: null,
    licenseSha256: null,
    artifacts: [],
    rows: 1,
    accepted: 1,
    missingPhone: 0,
    invalid: 0,
    duplicate: 0,
    issues: {},
  });
  const catalog = v.parse(CatalogSchema, {
    snapshot: "b".repeat(64),
    generatedAt: contact.retrievedAt,
    contacts: 1,
    phones: 1,
    sourceCount: 1,
    categories: [
      {
        id: "elementary_school",
        label: "小学校",
        contacts: 1,
        publisher: "例市",
        license: "CC0",
        licenseUrl: contact.licenseUrl,
      },
    ],
    prefectures: [{ code: "13", name: "東京都", contacts: 1 }],
    municipalities: [{ code: "13101", prefectureCode: "13", name: "千代田区" }],
  });
  try {
    db.exec("BEGIN");
    db.exec(databaseSchema);
    db.prepare("INSERT INTO contacts VALUES (1,?,?,?,?,?,?,?,?,?)").run(
      contact.id,
      contact.name,
      contact.name,
      contact.name,
      contact.prefectureCode,
      contact.municipalityCode,
      contact.category,
      contact.sourceId,
      JSON.stringify(contact),
    );
    db.prepare("INSERT INTO sources VALUES (?,?)").run(
      source.id,
      JSON.stringify(source),
    );
    db.prepare("INSERT INTO metadata VALUES ('catalog',?)").run(
      JSON.stringify(catalog),
    );
    db.exec("COMMIT");
    db.close();
    const output = join(root, "bundle");
    await prepareSnapshot(path, output);
    const cliOutput = join(root, "command-line");
    const preparedCommand = await command(
      process.execPath,
      ["tools/data.ts", "prepare", path, cliOutput],
      true,
    );
    expect(preparedCommand.code, preparedCommand.stderr).toBe(0);
    const cliManifest = v.parse(
      PreparedDatasetManifestSchema,
      JSON.parse(
        await readFile(join(cliOutput, "manifest.ready.json"), "utf8"),
      ),
    );
    expect(cliManifest.searchRanking).toBeUndefined();
    const prepared: unknown = JSON.parse(
      await readFile(join(output, "catalog.json"), "utf8"),
    );
    const checked = v.parse(CatalogSchema, prepared);
    expect(checked.contacts).toBe(1);
    expect(checked.phones).toBe(1);
    expect(checked.categories.map((category) => category.id)).toEqual([
      "elementary_school",
    ]);
    expect(checked.municipalities).toEqual(catalog.municipalities);
    const jsonl = gunzipSync(
      await readFile(join(output, "contacts.jsonl.gz")),
    ).toString("utf8");
    expect(JSON.parse(jsonl)).toMatchObject({
      id: contact.id,
      address: "東京都千代田区1-2-3",
    });
    expect(
      gunzipSync(await readFile(join(output, "contacts.csv.gz"))).toString(
        "utf8",
      ),
    ).toContain("東京都千代田区1-2-3");
    await checkDataBundle(output);
    const manifest = v.parse(
      PreparedDatasetManifestSchema,
      JSON.parse(await readFile(join(output, "manifest.ready.json"), "utf8")),
    );
    expect(manifest.files.map((file) => file.file)).toEqual([
      "contacts.jsonl.gz",
      "contacts.csv.gz",
      "contacts.vcf.gz",
      "directory.tsv.br",
    ]);
    const directoryPath = join(output, "directory.tsv.br");
    const directoryBytes = await readFile(directoryPath);
    const directory = decodeDirectoryArchive(
      brotliDecompressSync(directoryBytes).toString("utf8"),
    );
    expect(directory.header.snapshot).toBe(manifest.snapshot);
    expect(directory.header.sources).toEqual([
      { id: source.id, url: source.url },
    ]);
    expect(directory.rows).toHaveLength(1);
    expect(directory.rows[0]).toMatchObject({
      name: contact.name,
      municipalityCode: contact.municipalityCode,
      address: "東京都千代田区1-2-3",
      phones: contact.phones,
      sourceUrls: contact.sourceUrls,
    });
    const decodedText = brotliDecompressSync(directoryBytes).toString("utf8");
    for (const [text, message] of [
      [decodedText.replace(contact.name, "別小学校"), "differs"],
      [`${decodedText}\n`, "exceeds"],
    ] as const) {
      const changedArchive = compressDirectoryArchive(text);
      const changedDigest = createHash("sha256")
        .update(changedArchive)
        .digest("hex");
      await writeFile(directoryPath, changedArchive);
      await writeFile(
        join(output, "manifest.ready.json"),
        JSON.stringify({
          ...manifest,
          files: manifest.files.map((file) =>
            file.file === "directory.tsv.br"
              ? {
                  ...file,
                  sha256: changedDigest,
                  bytes: changedArchive.byteLength,
                  url: `/api/datasets/${manifest.snapshot}/${changedDigest}/${file.file}`,
                }
              : file,
          ),
        }),
      );
      await expect(checkDataBundle(output)).rejects.toThrow(
        `Directory archive ${message}`,
      );
    }
    await writeFile(directoryPath, directoryBytes);
    const archive = join(output, "contacts.jsonl.gz");
    const changed = gzipSync("unrelated directory\n");
    await writeFile(archive, changed);
    const digest = await fileDigest(archive);
    const altered = {
      ...manifest,
      files: manifest.files.map((file) =>
        file.file === "contacts.jsonl.gz"
          ? {
              ...file,
              sha256: digest,
              bytes: changed.byteLength,
              url: `/api/datasets/${manifest.snapshot}/${digest}/${file.file}`,
            }
          : file,
      ),
    };
    await writeFile(
      join(output, "manifest.ready.json"),
      JSON.stringify(altered),
    );
    await expect(checkDataBundle(output)).rejects.toThrow("JSONL archive");
    expect(
      gunzipSync(await readFile(join(output, "contacts.vcf.gz"))).toString(
        "utf8",
      ),
    ).toContain("東京都千代田区1-2-3");
  } finally {
    if (db.isOpen) db.close();
    await rm(root, { recursive: true, force: true });
  }
});

function writeInput(
  path: string,
  contacts: readonly Contact[],
  source: Source,
  catalog: Catalog,
): void {
  const db = new DatabaseSync(path);
  try {
    // One transaction keeps the storage syncs constant as the fixture grows.
    db.exec("BEGIN");
    db.exec(databaseSchema);
    const insert = db.prepare(
      "INSERT INTO contacts VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    for (const [index, contact] of contacts.entries())
      insert.run(
        index + 1,
        contact.id,
        contact.name,
        normalizeName(contact.name),
        searchForm(contact.name),
        contact.prefectureCode,
        contact.municipalityCode,
        contact.category,
        contact.sourceId,
        JSON.stringify(contact),
      );
    db.prepare("INSERT INTO sources VALUES (?,?)").run(
      source.id,
      JSON.stringify(source),
    );
    db.prepare("INSERT INTO metadata VALUES ('catalog',?)").run(
      JSON.stringify(catalog),
    );
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

it("numbers D1 rows by normalized name and identifier and rebuilds the search index", async () => {
  const root = await mkdtemp(join(tmpdir(), "phonebook-row-order-"));
  const contacts = (
    [
      ["c:0", "図書館", "13101", ["03-3581-2330"]],
      ["c:1", "Ｂ図書館", null, ["03-3581-2331", "090-1234-5678"]],
      ["c:2", "a図書館", "26366", ["03-3581-2332"]],
      ["c:3", "Ａ図書館", "26366", ["03-3581-2333"]],
      ["c:4", "ab", null, ["03-3581-2334"]],
      ["c:5", "𠮷野家", "13101", ["03-3581-2335"]],
      ["c:6", "\u{e000}施設", null, ["03-3581-2336"]],
    ] as const
  ).map(([id, name, municipalityCode, phones]) =>
    v.parse(ContactSchema, {
      id,
      name,
      category: "library",
      prefectureCode: municipalityCode?.slice(0, 2) ?? "13",
      municipalityCode,
      address:
        municipalityCode === null ? "東京都内" : "東京都千代田区永田町1-10-1",
      phones: phones.map((display) => ({
        display,
        e164: `+81${display.replaceAll("-", "").slice(1)}`,
      })),
      website: null,
      sourceId: "source",
      sourceRecordId: id,
      sourceUrls: ["https://example.go.jp/"],
      license: "CC0",
      licenseUrl: "https://example.go.jp/terms",
      dataAsOf: "2026-10-01",
      retrievedAt: "2026-10-30T00:00:00Z",
      phoneConfirmed: false,
      phoneConfirmationUrl: null,
    }),
  );
  const expectedOrder = ["c:4", "c:2", "c:3", "c:1", "c:0", "c:6", "c:5"];
  const source = v.parse(SourceSchema, {
    id: "source",
    url: "https://example.go.jp/data.csv",
    sha256: "a".repeat(64),
    dataAsOf: "2026-10-01",
    retrievedAt: "2026-10-30T00:00:00Z",
    indexUrl: null,
    indexSha256: null,
    licenseUrl: null,
    licenseSha256: null,
    artifacts: [],
    rows: contacts.length,
    accepted: contacts.length,
    missingPhone: 0,
    invalid: 0,
    duplicate: 0,
    issues: {},
  });
  const inputCatalog = v.parse(CatalogSchema, {
    snapshot: "b".repeat(64),
    generatedAt: "2026-10-30T00:00:00Z",
    contacts: contacts.length,
    phones: contacts.length + 1,
    sourceCount: 1,
    categories: [],
    prefectures: [],
    municipalities: [
      { code: "13101", prefectureCode: "13", name: "千代田区" },
      { code: "26366", prefectureCode: "26", name: "精華町" },
    ],
  });
  try {
    writeInput(join(root, "input.sqlite"), contacts, source, inputCatalog);
    const output = join(root, "bundle");
    await prepareSnapshot(join(root, "input.sqlite"), output);
    const manifestPath = join(output, "manifest.ready.json");
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = v.parse(
      PreparedDatasetManifestSchema,
      JSON.parse(manifestText),
    );
    const databasePath = join(output, "directory.sqlite");
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const rowids = new Map<string, number>();
    try {
      const rows = v.parse(
        v.array(v.object({ rowid: v.number(), id: v.string() })),
        db.prepare("SELECT rowid, id FROM contacts ORDER BY rowid").all(),
      );
      expect(rows.map((row) => row.id)).toEqual(expectedOrder);
      expect(rows.map((row) => row.rowid)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      for (const row of rows) rowids.set(row.id, row.rowid);
      for (const contact of contacts) {
        const numbers = db
          .prepare(
            "SELECT number FROM phones WHERE contact_rowid = ? ORDER BY number",
          )
          .all(rowids.get(contact.id) ?? 0)
          .map((row) => row.number);
        expect(numbers, contact.id).toEqual(
          contact.phones.map((phone) => phone.e164).sort(),
        );
        for (const term of nameTokens(searchForm(contact.name))) {
          const matched = db
            .prepare(
              "SELECT rowid FROM contact_search WHERE contact_search MATCH ? ORDER BY rowid",
            )
            .all(term)
            .map((row) => row.rowid);
          expect(matched, `${contact.id} ${term}`).toEqual(
            contacts
              .filter((other) =>
                nameTokens(searchForm(other.name)).includes(term),
              )
              .map((other) => rowids.get(other.id))
              .sort((left = 0, right = 0) => left - right),
          );
        }
      }
    } finally {
      db.close();
    }
    const jsonl = gunzipSync(await readFile(join(output, "contacts.jsonl.gz")));
    expect(createHash("sha256").update(jsonl).digest("hex")).toBe(
      manifest.snapshot,
    );
    expect(
      jsonl
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => v.parse(ContactSchema, JSON.parse(line)).id),
    ).toEqual(contacts.map((contact) => contact.id));
    const indexPath = join(output, "search-index.br");
    const compressedIndex = await readFile(indexPath);
    const indexBytes = brotliDecompressSync(compressedIndex);
    expect(manifest.searchIndex).toEqual({
      file: "search-index.br",
      sha256: createHash("sha256").update(compressedIndex).digest("hex"),
      bytes: compressedIndex.byteLength,
      uncompressedSha256: createHash("sha256").update(indexBytes).digest("hex"),
      uncompressedBytes: indexBytes.byteLength,
    });
    const index = decodeSearchIndex(indexBytes);
    expect(index.header.snapshot).toBe(manifest.snapshot);
    expect(index.header.regions).toEqual(["13", "13101", "26366"]);
    expect(index.rows.map((row) => [row.normalizedName, row.name])).toEqual(
      expectedOrder.map((id) => {
        const name = contacts.find((contact) => contact.id === id)?.name ?? "";
        return [normalizeName(name), name];
      }),
    );
    expect(index.rows[3]).toMatchObject({
      region: "13",
      phones: ["0335812331", "09012345678"],
    });
    await checkDataBundle(output);

    const catalog = v.parse(
      CatalogSchema,
      JSON.parse(await readFile(join(output, "catalog.json"), "utf8")),
    );
    const databaseBytes = await readFile(databasePath);
    async function rejectsIndex(
      bytes: Uint8Array,
      message: string,
    ): Promise<void> {
      await writeFile(indexPath, bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...manifest,
          searchIndex: { ...manifest.searchIndex, sha256, bytes: bytes.length },
        } satisfies PreparedDatasetManifest),
      );
      await expect(checkDataBundle(output), message).rejects.toThrow(message);
    }
    await rejectsIndex(
      compressSearchIndex(
        encodeSearchIndex(
          index.rows.map((row) =>
            row.name === "Ａ図書館" ? { ...row, name: "ａ図書館" } : row,
          ),
          { snapshot: manifest.snapshot, catalog },
        ),
      ),
      "Search index differs",
    );
    await rejectsIndex(
      compressSearchIndex(new Uint8Array([...indexBytes, 0x0a])),
      "Search index exceeds",
    );
    await rejectsIndex(
      new Uint8Array(searchIndexLimits.compressedBytes + 1),
      String(searchIndexLimits.compressedBytes),
    );
    await writeFile(indexPath, compressedIndex);
    await writeFile(manifestPath, manifestText);
    await checkDataBundle(output);

    await copyFile(databasePath, join(root, "original.sqlite"));
    const swapped = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: false,
    });
    try {
      swapped.exec(
        "UPDATE contacts SET rowid = 0 WHERE id = 'c:2'; UPDATE contacts SET rowid = 2 WHERE id = 'c:3'; UPDATE contacts SET rowid = 3 WHERE id = 'c:2'",
      );
    } finally {
      swapped.close();
    }
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        databaseSha256: await fileDigest(databasePath),
      } satisfies PreparedDatasetManifest),
    );
    await expect(checkDataBundle(output)).rejects.toThrow(
      "normalized name and identifier order",
    );
    await writeFile(databasePath, databaseBytes);
    await writeFile(manifestPath, manifestText);
    await checkDataBundle(output);

    const csvPath = join(output, "contacts.csv.gz");
    const csvBytes = await readFile(csvPath);
    const csvText = gunzipSync(csvBytes).toString("utf8");
    expect(csvText).toContain('"+81335812331;+819012345678"');
    const guarded = gzipSync(csvText.replaceAll('"+81', "\"'+81"));
    await writeFile(csvPath, guarded);
    const guardedDigest = await fileDigest(csvPath);
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        files: manifest.files.map((file) =>
          file.file === "contacts.csv.gz"
            ? {
                ...file,
                sha256: guardedDigest,
                bytes: guarded.byteLength,
                url: `/api/datasets/${manifest.snapshot}/${guardedDigest}/${file.file}`,
              }
            : file,
        ),
      } satisfies PreparedDatasetManifest),
    );
    await expect(checkDataBundle(output)).rejects.toThrow(
      "CSV telephone numbers differ from the JSONL archive: c:0",
    );
    await checkDataBundle(output, "retained");
    await writeFile(csvPath, csvBytes);
    await writeFile(manifestPath, manifestText);
    await checkDataBundle(output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const deltaFixtureCount = 600;

function deltaContacts(retrievedAt: string, prefix: string): Contact[] {
  return Array.from({ length: deltaFixtureCount }, (_, index) => {
    const digits = String(index).padStart(4, "0");
    return v.parse(ContactSchema, {
      id: `delta:${digits}`,
      name: `${prefix}${digits}号館`,
      category: index % 3 === 0 ? "library" : "medical",
      prefectureCode: index % 2 === 0 ? "13" : "26",
      municipalityCode: index % 2 === 0 ? "13101" : "26366",
      address: `所在地${digits}番地`,
      phones: [{ display: `03-3581-${digits}`, e164: `+8133581${digits}` }],
      website: null,
      sourceId: "source",
      sourceRecordId: digits,
      sourceUrls: [`https://example.go.jp/${index % 7}`],
      license: "CC0",
      licenseUrl: "https://example.go.jp/terms",
      dataAsOf: "2026-10-01",
      retrievedAt,
      phoneConfirmed: false,
      phoneConfirmationUrl: null,
    });
  });
}

function deltaSource(contacts: readonly Contact[]): Source {
  return v.parse(SourceSchema, {
    id: "source",
    url: "https://example.go.jp/data.csv",
    sha256: "a".repeat(64),
    dataAsOf: "2026-10-01",
    retrievedAt: contacts[0]?.retrievedAt ?? "2026-10-30T00:00:00Z",
    indexUrl: null,
    indexSha256: null,
    licenseUrl: null,
    licenseSha256: null,
    artifacts: [],
    rows: contacts.length,
    accepted: contacts.length,
    missingPhone: 0,
    invalid: 0,
    duplicate: 0,
    issues: {},
  });
}

const deltaCatalog = v.parse(CatalogSchema, {
  snapshot: "b".repeat(64),
  generatedAt: "2026-10-30T00:00:00Z",
  contacts: deltaFixtureCount,
  phones: deltaFixtureCount,
  sourceCount: 1,
  categories: [],
  prefectures: [],
  municipalities: [
    { code: "13101", prefectureCode: "13", name: "千代田区" },
    { code: "26366", prefectureCode: "26", name: "精華町" },
  ],
});

async function prepareContacts(
  root: string,
  name: string,
  contacts: readonly Contact[],
  bases: readonly string[] = [],
): Promise<PreparedDatasetManifest> {
  const input = join(root, `${name}.sqlite`);
  writeInput(input, contacts, deltaSource(contacts), {
    ...deltaCatalog,
    contacts: contacts.length,
  });
  await prepareSnapshot(input, join(root, name), undefined, bases);
  return v.parse(
    PreparedDatasetManifestSchema,
    JSON.parse(await readFile(join(root, name, "manifest.ready.json"), "utf8")),
  );
}

async function decoded(path: string): Promise<string> {
  return brotliDecompressSync(await readFile(path)).toString("utf8");
}

it("publishes a verified delta from an earlier prepared bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "phonebook-delta-"));
  try {
    const baseContacts = deltaContacts("2026-10-30T00:00:00Z", "図書館");
    const base = await prepareContacts(root, "base", baseContacts);
    expect(base.deltas).toEqual([]);
    const [removed, ...kept] = deltaContacts("2026-11-30T00:00:00Z", "図書館");
    expect(removed).toBeDefined();
    const targetContacts = kept.map((contact, index) =>
      index === 5 ? { ...contact, name: `${contact.name}分室` } : contact,
    );
    const target = await prepareContacts(
      root,
      "target",
      [
        ...targetContacts,
        v.parse(ContactSchema, { ...baseContacts[1], id: "delta:new" }),
      ],
      [join(root, "base")],
    );
    const archive = (
      manifest: PreparedDatasetManifest,
    ): PreparedDatasetManifest["files"][number] | undefined =>
      manifest.files.find((file) => file.file === "directory.tsv.br");
    const [artifact] = target.deltas;
    if (!artifact) throw new Error("The delta was not published");
    expect(target.deltas).toHaveLength(1);
    expect(artifact).toMatchObject({
      file: `directory-delta-${base.snapshot}.tsv.br`,
      base: base.snapshot,
      baseArchiveSha256: archive(base)?.sha256,
    });
    expect(artifact.bytes * 2).toBeLessThanOrEqual(archive(target)?.bytes ?? 0);
    expect(Object.keys(datasetFileListing(target))).not.toContain("deltas");
    await checkDataBundle(join(root, "target"));

    const baseText = await decoded(join(root, "base", "directory.tsv.br"));
    const targetText = await decoded(join(root, "target", "directory.tsv.br"));
    const deltaPath = join(root, "target", artifact.file);
    const deltaText = await decoded(deltaPath);
    const applied = applyDirectoryDelta(baseText, deltaText, sha256Digest);
    expect(applied.admission).toBe("apply");
    expect(applied.text).toBe(targetText);
    const delta = decodeDirectoryDelta(deltaText);
    if (!delta.ok) throw new Error(delta.error);
    expect(delta.value.header).toMatchObject({
      kept: deltaFixtureCount - 2,
      added: 2,
      removed: 2,
    });

    const manifestPath = join(root, "target", "manifest.ready.json");
    const manifestText = await readFile(manifestPath, "utf8");
    const deltaBytes = await readFile(deltaPath);
    const altered = deltaText.replace("分室", "別室");
    const alteredBytes = compressDirectoryArchive(altered);
    await writeFile(deltaPath, alteredBytes);
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...target,
        deltas: [
          {
            ...artifact,
            sha256: createHash("sha256").update(alteredBytes).digest("hex"),
            bytes: alteredBytes.byteLength,
            uncompressedSha256: createHash("sha256")
              .update(altered)
              .digest("hex"),
            uncompressedBytes: new TextEncoder().encode(altered).byteLength,
          },
        ],
      } satisfies PreparedDatasetManifest),
    );
    await expect(checkDataBundle(join(root, "target"))).rejects.toThrow(
      "Directory delta differs",
    );
    await writeFile(deltaPath, deltaBytes);
    await writeFile(manifestPath, manifestText);

    const source = await bundleDeltaSource(join(root, "base"));
    expect(source.snapshot).toBe(base.snapshot);
    expect((await source.read()).text).toBe(baseText);
    const unchecked = join(root, "unchecked");
    for (const [bases, message] of [
      [[join(root, "missing")], "ENOENT"],
      [[join(root, "base"), join(root, "base")], "distinct earlier snapshots"],
    ] as const) {
      await expect(
        prepareSnapshot(join(root, "target.sqlite"), unchecked, undefined, [
          ...bases,
        ]),
      ).rejects.toThrow(message);
      await expect(
        readFile(join(unchecked, "directory.sqlite")),
      ).rejects.toThrow("ENOENT");
    }
    const archivePath = join(root, "base", "directory.tsv.br");
    await writeFile(
      archivePath,
      compressDirectoryArchive(baseText.replace("図書館0001", "図書館9999")),
    );
    await expect(source.read()).rejects.toThrow("differs from its manifest");
    await expect(bundleDeltaSource(join(root, "base"))).rejects.toThrow(
      "differs from its manifest",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("writes a delta from every shipped and recently published base and reports an oversize shipped one", async () => {
  const root = await mkdtemp(join(tmpdir(), "phonebook-delta-retention-"));
  try {
    const store = fileControlStore(join(root, "store"));
    const earlier = deltaContacts("2026-10-30T00:00:00Z", "図書館");
    const stored = async (
      name: string,
      contacts: readonly Contact[],
    ): Promise<{
      readonly manifestSha256: string;
      readonly snapshot: string;
    }> => {
      const manifest = await prepareContacts(root, name, contacts);
      return {
        manifestSha256: await storeDataset(store, join(root, name)),
        snapshot: manifest.snapshot,
      };
    };
    const firstShipped = await stored("shipped-1", earlier.slice(1));
    const secondShipped = await stored("shipped-2", earlier.slice(2));
    const oversizeShipped = await stored(
      "shipped-3",
      deltaContacts("2026-10-30T00:00:00Z", "病院"),
    );
    const firstPublished = await stored("published-1", earlier.slice(3));
    const secondPublished = await stored("published-2", earlier.slice(4));
    const shipped = {
      datasets: [firstShipped, secondShipped, oversizeShipped].map(
        (dataset, index) => ({ ...dataset, firstAppVersion: `1.${index}` }),
      ),
    };
    const bases = join(root, "bases");
    const plan = await fetchDeltaBases(
      store,
      shipped,
      [firstPublished, secondPublished],
      bases,
    );
    expect(plan).toHaveLength(5);

    const targetContacts = deltaContacts("2026-11-30T00:00:00Z", "図書館").map(
      (contact, index) =>
        index === 5 ? { ...contact, name: `${contact.name}分室` } : contact,
    );
    const target = await prepareContacts(
      root,
      "target",
      targetContacts,
      await deltaBaseDirectories(bases),
    );
    expect(target.deltas.map((delta) => delta.base)).toEqual(
      [firstShipped, secondShipped, firstPublished, secondPublished]
        .map((dataset) => dataset.snapshot)
        .toSorted(),
    );
    await checkDataBundle(join(root, "target"));
    expect(unservedShippedBases(shipped, target)).toEqual([
      shipped.datasets[2],
    ]);

    const repeated = await prepareContacts(root, "repeated", targetContacts, [
      join(root, "target"),
    ]);
    expect(repeated.snapshot).toBe(target.snapshot);
    expect(repeated.deltas).toEqual([]);

    await writeFile(join(bases, "stray.txt"), "");
    await expect(deltaBaseDirectories(bases)).rejects.toThrow(
      "aren't bundles: stray.txt",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("prepares literal search by default and requires an explicit forgiving-search flag", () => {
  expect(parsePrepareArguments(["prepare", "source", "out"])).toMatchObject({
    forgivingSearch: false,
  });
  expect(
    parsePrepareArguments(["prepare", "source", "out", "--forgiving-search"]),
  ).toMatchObject({
    forgivingSearch: true,
  });
});

it("parses delta bases after the positional preparation arguments", () => {
  expect(
    parsePrepareArguments([
      "prepare",
      "source.sqlite",
      "out",
      "--delta-base",
      "first",
      "collection",
      "--delta-base",
      "second",
    ]),
  ).toEqual({
    source: "source.sqlite",
    output: "out",
    collection: "collection",
    deltaBases: ["first", "second"],
    deltaBaseRoot: undefined,
    forgivingSearch: false,
  });
  expect(parsePrepareArguments(["prepare", "source", "out", ""])).toEqual({
    source: "source",
    output: "out",
    collection: undefined,
    deltaBases: [],
    deltaBaseRoot: undefined,
    forgivingSearch: false,
  });
  expect(
    parsePrepareArguments([
      "prepare",
      "source",
      "out",
      "",
      "--delta-base-root",
      "bases",
    ]),
  ).toEqual({
    source: "source",
    output: "out",
    collection: undefined,
    deltaBases: [],
    deltaBaseRoot: "bases",
    forgivingSearch: false,
  });
  for (const args of [
    ["prepare", "source"],
    ["prepare", "source", "out", "--delta-base"],
    ["prepare", "source", "out", "--delta-base-root"],
    ["prepare", "source", "out", "--unknown"],
    ["prepare", "source", "out", "--forgiving-search", "--forgiving-search"],
    [
      "prepare",
      "source",
      "out",
      "--delta-base-root",
      "a",
      "--delta-base-root",
      "b",
    ],
    ["prepare", "source", "out", "collection", "extra"],
    ["publish", "source", "out"],
  ])
    expect(() => parsePrepareArguments(args), args.join(" ")).toThrow("Usage");
});
