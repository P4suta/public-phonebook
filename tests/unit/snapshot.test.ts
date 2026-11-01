import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import * as v from "valibot";
import { expect, it } from "vitest";
import {
  type PreparedDatasetManifest,
  PreparedDatasetManifestSchema,
} from "../../src/core/dataset-storage.ts";
import { decodeDirectoryArchive } from "../../src/core/directory-archive.ts";
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
import { checkDataBundle } from "../../tools/check-data.ts";
import { databaseSchema } from "../../tools/database-schema.ts";
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
    db.exec(databaseSchema);
    db.prepare("INSERT INTO contacts VALUES (1,?,?,?,?,?,?,?,?)").run(
      contact.id,
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
    db.close();
    const output = join(root, "bundle");
    await prepareSnapshot(path, output);
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
    db.exec(databaseSchema);
    for (const [index, contact] of contacts.entries())
      db.prepare("INSERT INTO contacts VALUES (?,?,?,?,?,?,?,?,?)").run(
        index + 1,
        contact.id,
        contact.name,
        normalizeName(contact.name),
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
        for (const term of nameTokens(normalizeName(contact.name))) {
          const matched = db
            .prepare(
              "SELECT rowid FROM contact_search WHERE contact_search MATCH ? ORDER BY rowid",
            )
            .all(term)
            .map((row) => row.rowid);
          expect(matched, `${contact.id} ${term}`).toEqual(
            contacts
              .filter((other) =>
                nameTokens(normalizeName(other.name)).includes(term),
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
      randomBytes(searchIndexLimits.compressedBytes + 1),
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
