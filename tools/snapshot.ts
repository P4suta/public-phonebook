import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { stringify } from "csv-stringify/sync";
import * as v from "valibot";
import { categoryDefinitions, prefectureNames } from "../src/core/catalog.ts";
import {
  type Catalog,
  CatalogSchema,
  type Contact,
} from "../src/core/models.ts";
import { nameTokens, normalizeName } from "../src/core/search.ts";
import { contactVCard } from "../src/core/vcard.ts";
import { categorySources } from "./category-sources.ts";
import { databaseSchema } from "./database-schema.ts";
import { importContact, importSource } from "./import-contact.ts";

const preparationProgressInterval = 100000;
const prefectureCodeWidth = 2;
const archiveCompressionLevel = 6;
const jsonIndentation = 2;

export interface SnapshotResult {
  readonly snapshot: string;
  readonly directory: string;
  readonly contacts: number;
  readonly bytes: number;
}

export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    const bytes: unknown = chunk;
    if (!(bytes instanceof Uint8Array)) throw new Error("Expected file bytes");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export async function prepareSnapshot(
  sourcePath: string,
  outputPath: string,
): Promise<SnapshotResult> {
  const source = resolve(sourcePath);
  const destination = resolve(outputPath);
  if (source.startsWith(`${destination}/`))
    throw new Error("The source must be outside the output directory");
  await mkdir(destination, { recursive: false });
  const input = new DatabaseSync(source, { readOnly: true });
  const output = new DatabaseSync(join(destination, "directory.sqlite"));
  const stream = createWriteStream(join(destination, "contacts.jsonl"), {
    flags: "wx",
  });
  const csv = createWriteStream(join(destination, "contacts.csv"), {
    flags: "wx",
  });
  const vcard = createWriteStream(join(destination, "contacts.vcf"), {
    flags: "wx",
  });
  const hash = createHash("sha256");
  const categoryCounts = new Map<string, number>();
  const prefectureCounts = new Map<string, number>();
  const municipalities = new Map<
    string,
    { code: string; prefectureCode: string; name: string }
  >();
  let contacts = 0;
  try {
    const rawCoverage = input
      .prepare("SELECT payload FROM metadata WHERE key = 'coverage'")
      .get();
    const coverage = v.parse(v.object({ payload: v.string() }), rawCoverage);
    const decoded: unknown = JSON.parse(coverage.payload);
    const metadata = v.parse(
      v.object({
        generated_at: v.string(),
        total_contacts: v.number(),
        unique_phone_numbers: v.number(),
        sources: v.array(v.unknown()),
      }),
      decoded,
    );
    const sources = metadata.sources.map(importSource);
    const sourceIds = new Set(sources.map((item) => item.id));
    output.exec(databaseSchema);
    output.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; BEGIN",
    );
    const insert = output.prepare(
      "INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const phoneInsert = output.prepare(
      "INSERT OR IGNORE INTO phones VALUES (?, ?)",
    );
    const searchInsert = output.prepare(
      "INSERT INTO contact_search(rowid, terms) VALUES (?, ?)",
    );
    csv.write(
      "id,name,category,prefecture_code,municipality_code,address,phone_numbers,website,source_id,source_url,license,license_url,data_as_of\r\n",
    );
    for (const row of input
      .prepare("SELECT payload FROM contacts ORDER BY id")
      .iterate()) {
      const parsed = v.parse(v.object({ payload: v.string() }), row);
      const value: unknown = JSON.parse(parsed.payload);
      const contact = importContact(value);
      if (!sourceIds.has(contact.sourceId))
        throw new Error(`Missing source: ${contact.sourceId}`);
      if (
        contact.municipalityCode &&
        !contact.municipalityCode.startsWith(contact.prefectureCode)
      )
        throw new Error(`Conflicting region: ${contact.id}`);
      contacts += 1;
      const normalized = normalizeName(contact.name);
      const payload = JSON.stringify(contact);
      insert.run(
        contacts,
        contact.id,
        contact.name,
        normalized,
        contact.prefectureCode,
        contact.municipalityCode,
        contact.category,
        contact.sourceId,
        payload,
      );
      for (const phone of contact.phones) phoneInsert.run(phone.e164, contacts);
      searchInsert.run(contacts, nameTokens(normalized).join(" "));
      categoryCounts.set(
        contact.category,
        (categoryCounts.get(contact.category) ?? 0) + 1,
      );
      prefectureCounts.set(
        contact.prefectureCode,
        (prefectureCounts.get(contact.prefectureCode) ?? 0) + 1,
      );
      if (contact.category === "municipal_office" && contact.municipalityCode)
        municipalities.set(contact.municipalityCode, {
          code: contact.municipalityCode,
          prefectureCode: contact.prefectureCode,
          name: contact.name.replace(/(?:役所|役場)$/u, ""),
        });
      hash.update(`${payload}\n`);
      if (!stream.write(`${payload}\n`)) await once(stream, "drain");
      if (!csv.write(contactCsv(contact))) await once(csv, "drain");
      if (!vcard.write(contactVCard(contact))) await once(vcard, "drain");
      if (contacts % preparationProgressInterval === 0)
        console.info(JSON.stringify({ phase: "prepare", contacts }));
    }
    if (contacts !== metadata.total_contacts)
      throw new Error("The source contact count changed");
    const snapshot = hash.digest("hex");
    const catalog: Catalog = v.parse(CatalogSchema, {
      snapshot,
      generatedAt: metadata.generated_at,
      contacts,
      phones: metadata.unique_phone_numbers,
      sourceCount: sources.length,
      categories: categoryDefinitions.map((category) => ({
        id: category.id,
        label: category.label,
        contacts: categoryCounts.get(category.id) ?? 0,
        ...categorySources.find((source) => source.id === category.id),
      })),
      prefectures: prefectureNames.map((name, index) => {
        const code = String(index + 1).padStart(prefectureCodeWidth, "0");
        return { code, name, contacts: prefectureCounts.get(code) ?? 0 };
      }),
      municipalities: Array.from(municipalities.values()).sort((a, b) =>
        a.code.localeCompare(b.code),
      ),
    });
    const sourceInsert = output.prepare("INSERT INTO sources VALUES (?, ?)");
    for (const source of sources)
      sourceInsert.run(source.id, JSON.stringify(source));
    output
      .prepare("INSERT INTO metadata VALUES ('catalog', ?)")
      .run(JSON.stringify(catalog));
    output.exec(
      "INSERT INTO contact_search(contact_search) VALUES('optimize'); COMMIT; PRAGMA optimize",
    );
    for (const target of [stream, csv, vcard]) {
      target.end();
      await once(target, "finish");
    }
    const phoneRow = v.parse(
      v.object({ phones: v.number() }),
      output
        .prepare("SELECT COUNT(DISTINCT number) AS phones FROM phones")
        .get(),
    );
    if (phoneRow.phones !== catalog.phones)
      throw new Error("The unique telephone count changed");
    const integrity = v.parse(
      v.object({ integrity_check: v.string() }),
      output.prepare("PRAGMA integrity_check").get(),
    );
    if (integrity.integrity_check !== "ok")
      throw new Error("The prepared database failed its integrity check");
    output.close();
    input.close();
    const files = [];
    for (const file of ["contacts.jsonl", "contacts.csv", "contacts.vcf"]) {
      await pipeline(
        createReadStream(join(destination, file)),
        createGzip({ level: archiveCompressionLevel }),
        createWriteStream(join(destination, `${file}.gz`), { flags: "wx" }),
      );
      const sha256 = await fileDigest(join(destination, `${file}.gz`));
      files.push({
        file: `${file}.gz`,
        sha256,
        bytes: (await stat(join(destination, `${file}.gz`))).size,
        url: `/api/datasets/${snapshot}/${sha256}/${file}.gz`,
      });
    }
    await writeFile(
      join(destination, "catalog.json"),
      `${JSON.stringify(catalog)}\n`,
      { flag: "wx" },
    );
    const manifest = {
      snapshot,
      generatedAt: catalog.generatedAt,
      contacts,
      phones: catalog.phones,
      sourceCount: sources.length,
      sourceDatabaseSha256: await fileDigest(source),
      databaseSha256: await fileDigest(join(destination, "directory.sqlite")),
      files,
    };
    await writeFile(
      join(destination, "manifest.json"),
      `${JSON.stringify(manifest, null, jsonIndentation)}\n`,
      { flag: "wx" },
    );
    const bytes = (await stat(join(destination, "directory.sqlite"))).size;
    await rename(
      join(destination, "manifest.json"),
      join(destination, "manifest.ready.json"),
    );
    return { snapshot, directory: destination, contacts, bytes };
  } catch (error) {
    stream.destroy();
    csv.destroy();
    vcard.destroy();
    const failures: unknown[] = [error];
    for (const database of [output, input]) {
      try {
        if (database.isOpen) database.close();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Snapshot preparation and cleanup failed",
        { cause: error },
      );
    throw error;
  }
}

export function contactCsv(contact: Contact): string {
  const values = [
    contact.id,
    contact.name,
    contact.category,
    contact.prefectureCode,
    contact.municipalityCode ?? "",
    contact.address,
    contact.phones.map((phone) => phone.e164).join(";"),
    contact.website ?? "",
    contact.sourceId,
    contact.sourceUrls.join(" "),
    contact.license,
    contact.licenseUrl,
    contact.dataAsOf,
  ];
  return stringify([values], {
    quoted: true,
    quoted_empty: true,
    record_delimiter: "\r\n",
    escape_formulas: true,
  });
}
