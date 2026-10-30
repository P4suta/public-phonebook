import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import * as v from "valibot";
import { categoryDefinitions, prefectureNames } from "../src/core/catalog.ts";
import {
  CatalogSchema,
  ContactSchema,
  DatasetManifestSchema,
  SourceSchema,
} from "../src/core/models.ts";
import { nameTokens, normalizeName } from "../src/core/search.ts";
import { contactVCard } from "../src/core/vcard.ts";
import { categorySources } from "./category-sources.ts";
import { databaseSchema } from "./database-schema.ts";
import { seedLocalData } from "./local-data.ts";
import { contactCsv, fileDigest } from "./snapshot.ts";

const fixtureWebsite = "https://example.org/";
const fixtureDatasetUrl = "https://example.org/dataset";
const fixtureLicenseUrl = "https://creativecommons.org/publicdomain/zero/1.0/";
const fixtureArchiveUrl = "https://example.org/data.csv";
const prefectureCodeWidth = 2;
const digestCharacterCount = 64;
const fixtureContactCount = 3;
const fixtureServerPort = 8790;

export async function prepareCheckFixture(): Promise<void> {
  const directory = ".local/check-fixture";
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const contacts = [
    ["国立国会図書館", "13", "13101", "03-3581-2331", "+81335812331"],
    [
      "国立国会図書館国際子ども図書館",
      "13",
      "13106",
      "03-3827-2053",
      "+81338272053",
    ],
    ["国立国会図書館関西館", "26", "26366", "0774-98-1200", "+81774981200"],
  ].map(([name, prefectureCode, municipalityCode, display, e164], index) =>
    v.parse(ContactSchema, {
      id: `fixture:${index}`,
      name,
      category: "library",
      prefectureCode,
      municipalityCode,
      address: "東京都千代田区永田町1-10-1",
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
  const db = new DatabaseSync(join(directory, "directory.sqlite"));
  try {
    db.exec(databaseSchema);
    for (const [index, contact] of contacts.entries()) {
      db.prepare("INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
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
      db.prepare("INSERT INTO phones VALUES (?, ?)").run(
        contact.phones[0]?.e164 ?? "",
        index + 1,
      );
      db.prepare("INSERT INTO contact_search(rowid, terms) VALUES (?, ?)").run(
        index + 1,
        nameTokens(normalizeName(contact.name)).join(" "),
      );
    }
    db.prepare("INSERT INTO metadata VALUES ('catalog', ?)").run(
      JSON.stringify(catalog),
    );
    db.prepare("INSERT INTO sources VALUES (?, ?)").run(
      source.id,
      JSON.stringify(source),
    );
  } finally {
    db.close();
  }
  const files = [];
  for (const [file, content] of [
    ["contacts.jsonl.gz", jsonl],
    ["contacts.csv.gz", contacts.map(contactCsv).join("")],
    ["contacts.vcf.gz", contacts.map(contactVCard).join("")],
  ] as const) {
    const bytes = gzipSync(content);
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
  const manifest = v.parse(DatasetManifestSchema, {
    snapshot,
    generatedAt: catalog.generatedAt,
    contacts: contacts.length,
    phones: contacts.length,
    sourceCount: 1,
    sourceDatabaseSha256: databaseSha256,
    databaseSha256,
    files,
  });
  await writeFile(join(directory, "catalog.json"), JSON.stringify(catalog));
  await writeFile(
    join(directory, "manifest.ready.json"),
    JSON.stringify(manifest),
  );
  await seedLocalData(directory, {
    state: ".local/check-state",
    port: fixtureServerPort,
  });
}
