import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGunzip } from "node:zlib";
import * as v from "valibot";
import { normalizeAddress } from "../src/core/address.ts";
import { normalizeName } from "../src/core/identity.ts";
import {
  CatalogSchema,
  ContactSchema,
  type DatasetManifest,
  DatasetManifestSchema,
  SourceSchema,
} from "../src/core/models.ts";
import { fileDigest } from "./snapshot.ts";

const commandArgumentOffset = 2;

export async function checkDataBundle(
  directory: string,
  addressPolicy: "canonical" | "retained" = "canonical",
): Promise<DatasetManifest> {
  const decoded: unknown = JSON.parse(
    await readFile(join(directory, "manifest.ready.json"), "utf8"),
  );
  const manifest = v.parse(DatasetManifestSchema, decoded);
  const path = join(directory, "directory.sqlite");
  if ((await fileDigest(path)) !== manifest.databaseSha256)
    throw new Error("Database checksum mismatch");
  for (const file of manifest.files)
    if (
      (await stat(join(directory, file.file))).size !== file.bytes ||
      (await fileDigest(join(directory, file.file))) !== file.sha256
    )
      throw new Error(`Dataset artifact mismatch: ${file.file}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const catalogValue: unknown = JSON.parse(
      v.parse(
        v.object({ payload: v.string() }),
        db.prepare("SELECT payload FROM metadata WHERE key='catalog'").get(),
      ).payload,
    );
    const catalog = v.parse(CatalogSchema, catalogValue);
    const catalogFile = v.parse(
      CatalogSchema,
      JSON.parse(await readFile(join(directory, "catalog.json"), "utf8")),
    );
    if (JSON.stringify(catalogFile) !== JSON.stringify(catalog))
      throw new Error("Catalog artifact mismatch");
    const sources = new Set<string>();
    for (const row of db.prepare("SELECT id, payload FROM sources").iterate()) {
      const value: unknown = JSON.parse(v.parse(v.string(), row.payload));
      const source = v.parse(SourceSchema, value);
      if (source.id !== row.id) throw new Error("Source index mismatch");
      sources.add(source.id);
    }
    const hash = createHash("sha256");
    const categories = new Map<string, number>();
    const prefectures = new Map<string, number>();
    let contacts = 0;
    let phones = 0;
    let snapshotBytes = 0;
    for (const row of db
      .prepare("SELECT * FROM contacts ORDER BY id")
      .iterate()) {
      const value: unknown = JSON.parse(v.parse(v.string(), row.payload));
      const contact = v.parse(ContactSchema, value);
      if (
        addressPolicy === "canonical" &&
        normalizeAddress(contact.address) !== contact.address
      )
        throw new Error(`Noncanonical address: ${contact.id}`);
      if (
        row.id !== contact.id ||
        row.name !== contact.name ||
        row.normalized_name !== normalizeName(contact.name) ||
        row.prefecture !== contact.prefectureCode ||
        row.municipality !== contact.municipalityCode ||
        row.category !== contact.category ||
        row.source_id !== contact.sourceId ||
        !sources.has(contact.sourceId)
      )
        throw new Error(`Contact index mismatch: ${contact.id}`);
      if (
        contact.municipalityCode &&
        !contact.municipalityCode.startsWith(contact.prefectureCode)
      )
        throw new Error(`Contact region mismatch: ${contact.id}`);
      const line = `${JSON.stringify(contact)}\n`;
      hash.update(line);
      snapshotBytes += new TextEncoder().encode(line).byteLength;
      contacts += 1;
      phones += contact.phones.length;
      categories.set(
        contact.category,
        (categories.get(contact.category) ?? 0) + 1,
      );
      prefectures.set(
        contact.prefectureCode,
        (prefectures.get(contact.prefectureCode) ?? 0) + 1,
      );
    }
    const counts = v.parse(
      v.object({
        phones: v.number(),
        relations: v.number(),
        indexed: v.number(),
      }),
      db
        .prepare(
          "SELECT (SELECT count(DISTINCT number) FROM phones) AS phones, (SELECT count(*) FROM phones) AS relations, (SELECT count(*) FROM contact_search) AS indexed",
        )
        .get(),
    );
    if (
      hash.digest("hex") !== manifest.snapshot ||
      catalog.snapshot !== manifest.snapshot ||
      contacts !== manifest.contacts ||
      catalog.contacts !== contacts ||
      sources.size !== manifest.sourceCount ||
      catalog.sourceCount !== sources.size ||
      counts.phones !== manifest.phones ||
      catalog.phones !== counts.phones ||
      phones !== counts.relations ||
      counts.indexed !== contacts
    )
      throw new Error("Snapshot accounting mismatch");
    for (const category of catalog.categories)
      if ((categories.get(category.id) ?? 0) !== category.contacts)
        throw new Error("Category accounting mismatch");
    for (const prefecture of catalog.prefectures)
      if ((prefectures.get(prefecture.code) ?? 0) !== prefecture.contacts)
        throw new Error("Prefecture accounting mismatch");
    if (
      catalog.categories.length !== categories.size ||
      new Set(catalog.categories.map((item) => item.id)).size !==
        categories.size ||
      catalog.categories.reduce((sum, item) => sum + item.contacts, 0) !==
        contacts ||
      new Set(catalog.prefectures.map((item) => item.code)).size !==
        catalog.prefectures.length ||
      catalog.prefectures.reduce((sum, item) => sum + item.contacts, 0) !==
        contacts
    )
      throw new Error("Incomplete catalog partition");
    const archiveHash = createHash("sha256");
    let archiveBytes = 0;
    for await (const chunk of createReadStream(
      join(directory, "contacts.jsonl.gz"),
    ).compose(createGunzip())) {
      const value: unknown = chunk;
      if (!(value instanceof Uint8Array))
        throw new Error("JSONL archive did not yield bytes");
      archiveBytes += value.byteLength;
      if (archiveBytes > snapshotBytes)
        throw new Error("JSONL archive exceeds its directory");
      archiveHash.update(value);
    }
    if (
      archiveBytes !== snapshotBytes ||
      archiveHash.digest("hex") !== manifest.snapshot
    )
      throw new Error("JSONL archive differs from its directory");
    const integrity = v.parse(
      v.object({ integrity_check: v.literal("ok") }),
      db.prepare("PRAGMA integrity_check").get(),
    );
    console.info(
      JSON.stringify({
        operation: "data.check",
        contacts,
        phones: counts.phones,
        sources: sources.size,
        snapshot: manifest.snapshot,
        integrity: integrity.integrity_check,
        addressPolicy,
      }),
    );
    return manifest;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [directory, ...extra] = process.argv.slice(commandArgumentOffset);
  if (!directory || extra.length)
    throw new Error("Usage: npm run data:check -- BUNDLE_DIRECTORY");
  await checkDataBundle(resolve(directory));
}
