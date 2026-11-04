import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import * as v from "valibot";
import { categoryDefinitions, prefectureNames } from "../src/core/catalog.ts";
import { PreparedDatasetManifestSchema } from "../src/core/dataset-storage.ts";
import {
  directoryArchiveFile,
  encodeDirectoryArchive,
} from "../src/core/directory-archive.ts";
import {
  CatalogSchema,
  type Contact,
  ContactSchema,
  SourceSchema,
} from "../src/core/models.ts";
import { nameTokens, normalizeName } from "../src/core/search.ts";
import { searchIndexFile } from "../src/core/search-index.ts";
import { searchForm } from "../src/core/search-text.ts";
import { contactVCard } from "../src/core/vcard.ts";
import { categorySources } from "./category-sources.ts";
import { databaseSchema } from "./database-schema.ts";
import { seedLocalData } from "./local-data.ts";
import { compressSearchIndex, readSearchIndex } from "./search-index.ts";
import {
  compressDirectoryArchive,
  contactCsv,
  contactCsvHeader,
  contactRowNumbers,
  fileDigest,
} from "./snapshot.ts";

const fixtureWebsite = "https://example.org/";
const fixtureDatasetUrl = "https://example.org/dataset";
const fixtureLicenseUrl = "https://creativecommons.org/publicdomain/zero/1.0/";
const fixtureArchiveUrl = "https://example.org/data.csv";
const prefectureCodeWidth = 2;
const digestCharacterCount = 64;
const fixtureAddress = "東京都千代田区永田町1-10-1";
const fixtureContactCount = 4;
const fixtureServerPort = 8790;

/** Lists the libraries with an address, and a police box that the national data also lists without one. */
export function checkFixtureContacts(): Contact[] {
  return [
    {
      name: "国立国会図書館",
      category: "library",
      prefectureCode: "13",
      municipalityCode: "13101",
      address: fixtureAddress,
      display: "03-3581-2331",
      e164: "+81335812331",
    },
    {
      name: "国立国会図書館国際子ども図書館",
      category: "library",
      prefectureCode: "13",
      municipalityCode: "13106",
      address: fixtureAddress,
      display: "03-3827-2053",
      e164: "+81338272053",
    },
    {
      name: "国立国会図書館関西館",
      category: "library",
      prefectureCode: "26",
      municipalityCode: "26366",
      address: fixtureAddress,
      display: "0774-98-1200",
      e164: "+81774981200",
    },
    {
      name: "いなべ警察署　東員交番",
      category: "police_station",
      prefectureCode: "24",
      municipalityCode: null,
      address: "",
      display: "0594-76-7410",
      e164: "+81594767410",
    },
  ].map(({ display, e164, ...row }, index) =>
    v.parse(ContactSchema, {
      ...row,
      id: `fixture:${index}`,
      phones: [{ display, e164 }],
      website: fixtureWebsite,
      sourceId: "fixture",
      sourceRecordId: String(index),
      sourceUrls: [fixtureDatasetUrl],
      license: "CC0-1.0",
      licenseUrl: fixtureLicenseUrl,
      dataAsOf: "2026-10-01",
      retrievedAt: "2026-10-29T00:00:00Z",
      phoneConfirmed: false,
      phoneConfirmationUrl: null,
    }),
  );
}

/** Writes a complete four-contact bundle that passes the data check. */
export async function writeCheckFixture(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const contacts = checkFixtureContacts();
  const jsonl = contacts
    .map((contact) => `${JSON.stringify(contact)}\n`)
    .join("");
  const snapshot = createHash("sha256").update(jsonl).digest("hex");
  const catalog = v.parse(CatalogSchema, {
    snapshot,
    generatedAt: "2026-10-29T00:00:00Z",
    contacts: contacts.length,
    phones: contacts.length,
    sourceCount: 1,
    categories: categoryDefinitions
      .filter((category) =>
        contacts.some((contact) => contact.category === category.id),
      )
      .map((category) => ({
        ...categorySources.find((source) => source.id === category.id),
        id: category.id,
        label: category.label,
        contacts: contacts.filter((contact) => contact.category === category.id)
          .length,
      })),
    prefectures: prefectureNames.map((name, index) => ({
      code: String(index + 1).padStart(prefectureCodeWidth, "0"),
      name,
      contacts: contacts.filter(
        (contact) =>
          contact.prefectureCode ===
          String(index + 1).padStart(prefectureCodeWidth, "0"),
      ).length,
    })),
    municipalities: [
      { code: "13101", prefectureCode: "13", name: "千代田区" },
      { code: "13106", prefectureCode: "13", name: "台東区" },
    ],
  });
  const source = v.parse(SourceSchema, {
    id: "fixture",
    url: fixtureArchiveUrl,
    sha256: "a".repeat(digestCharacterCount),
    dataAsOf: "2026-10-01",
    retrievedAt: "2026-10-29T00:00:00Z",
    indexUrl: null,
    indexSha256: null,
    licenseUrl: null,
    licenseSha256: null,
    artifacts: [],
    rows: fixtureContactCount,
    accepted: fixtureContactCount,
    missingPhone: 0,
    invalid: 0,
    duplicate: 0,
    issues: {},
  });
  const rowNumbers = contactRowNumbers(contacts);
  const db = new DatabaseSync(join(directory, "directory.sqlite"));
  let searchIndex: Uint8Array;
  try {
    db.exec(databaseSchema);
    for (const contact of contacts) {
      const rowid = rowNumbers.get(contact.id);
      if (rowid === undefined) throw new Error("Missing fixture row number");
      db.prepare(
        "INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        rowid,
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
      db.prepare("INSERT INTO phones VALUES (?, ?)").run(
        contact.phones[0]?.e164 ?? "",
        rowid,
      );
      db.prepare("INSERT INTO contact_search(rowid, terms) VALUES (?, ?)").run(
        rowid,
        nameTokens(searchForm(contact.name)).join(" "),
      );
    }
    db.prepare("INSERT INTO metadata VALUES ('catalog', ?)").run(
      JSON.stringify(catalog),
    );
    db.prepare("INSERT INTO sources VALUES (?, ?)").run(
      source.id,
      JSON.stringify(source),
    );
    searchIndex = readSearchIndex(db, { snapshot, catalog });
  } finally {
    db.close();
  }
  const compressedIndex = compressSearchIndex(searchIndex);
  await writeFile(join(directory, searchIndexFile), compressedIndex);
  const files = [];
  for (const [file, bytes] of [
    ["contacts.jsonl.gz", gzipSync(jsonl)],
    [
      "contacts.csv.gz",
      gzipSync(`${contactCsvHeader}${contacts.map(contactCsv).join("")}`),
    ],
    ["contacts.vcf.gz", gzipSync(contacts.map(contactVCard).join(""))],
    [
      directoryArchiveFile,
      compressDirectoryArchive(
        encodeDirectoryArchive(contacts, {
          snapshot,
          catalog,
          sources: [source],
        }),
      ),
    ],
  ] as const) {
    await writeFile(join(directory, file), bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    files.push({
      file,
      bytes: bytes.byteLength,
      sha256,
      url: `/api/datasets/${snapshot}/${sha256}/${file}`,
    });
  }
  const databaseSha256 = await fileDigest(join(directory, "directory.sqlite"));
  const manifest = v.parse(PreparedDatasetManifestSchema, {
    snapshot,
    generatedAt: catalog.generatedAt,
    contacts: contacts.length,
    phones: contacts.length,
    sourceCount: 1,
    sourceDatabaseSha256: databaseSha256,
    databaseSha256,
    files,
    searchIndex: {
      file: searchIndexFile,
      sha256: createHash("sha256").update(compressedIndex).digest("hex"),
      bytes: compressedIndex.byteLength,
      uncompressedSha256: createHash("sha256")
        .update(searchIndex)
        .digest("hex"),
      uncompressedBytes: searchIndex.byteLength,
    },
  });
  await writeFile(join(directory, "catalog.json"), JSON.stringify(catalog));
  await writeFile(
    join(directory, "manifest.ready.json"),
    JSON.stringify(manifest),
  );
}

export async function prepareCheckFixture(): Promise<void> {
  const directory = ".local/check-fixture";
  await writeCheckFixture(directory);
  await seedLocalData(directory, {
    state: ".local/check-state",
    port: fixtureServerPort,
  });
}
