import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import {
  type BrotliOptions,
  brotliCompressSync,
  constants,
  createBrotliCompress,
  createGzip,
} from "node:zlib";
import { categorySources } from "@public-phonebook/data/category-sources";
import {
  mergeContacts,
  readCollectionOverlay,
} from "@public-phonebook/data/collection/overlay";
import { databaseSchema } from "@public-phonebook/data/database-schema";
import {
  deltaSource,
  requireDistinctSources,
  writeDirectoryDeltas,
} from "@public-phonebook/data/directory-delta";
import {
  importContact,
  importSource,
} from "@public-phonebook/data/import-contact";
import {
  compressSearchIndex,
  readSearchIndex,
} from "@public-phonebook/data/search-index";
import { writeSearchRanking } from "@public-phonebook/data/search-ranking";
import { normalizeAddress } from "@public-phonebook/directory/address";
import {
  categoryDefinitions,
  prefectureNames,
} from "@public-phonebook/directory/catalog";
import { PreparedDatasetManifestSchema } from "@public-phonebook/directory/dataset-storage";
import {
  directoryArchiveEncoder,
  directoryArchiveFile,
} from "@public-phonebook/directory/directory-archive";
import {
  type Catalog,
  CatalogSchema,
  type Contact,
  ContactSchema,
  E164Schema,
  type Source,
  SourceSchema,
} from "@public-phonebook/directory/models";
import { nameTokens, normalizeName } from "@public-phonebook/directory/search";
import {
  compareRowOrder,
  decodeSearchIndex,
  type RowKey,
  searchIndexFile,
} from "@public-phonebook/directory/search-index";
import { searchForm } from "@public-phonebook/directory/search-text";
import { contactVCard } from "@public-phonebook/directory/vcard";
import { stringify } from "csv-stringify/sync";
import * as v from "valibot";

const preparationProgressInterval = 100000;
const prefectureCodeWidth = 2;
const archiveCompressionLevel = 6;
const directoryArchiveQuality = 11;
const directoryArchiveWindowBits = 24;
const jsonIndentation = 2;

export function directoryArchiveCompression(bytes: number): BrotliOptions {
  return {
    params: {
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_QUALITY]: directoryArchiveQuality,
      [constants.BROTLI_PARAM_LGWIN]: directoryArchiveWindowBits,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes,
    },
  };
}

export function compressDirectoryArchive(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  return brotliCompressSync(
    bytes,
    directoryArchiveCompression(bytes.byteLength),
  );
}

interface SnapshotInput {
  readonly generatedAt: string;
  readonly contacts: number;
  readonly sources: readonly Source[];
  readonly municipalities: Catalog["municipalities"];
  readonly legacy: boolean;
}

function snapshotInput(input: DatabaseSync): SnapshotInput {
  const native = input
    .prepare("SELECT payload FROM metadata WHERE key = 'catalog'")
    .get();
  if (native) {
    const value: unknown = JSON.parse(v.parse(v.string(), native.payload));
    const catalog = v.parse(CatalogSchema, value);
    const sources = input
      .prepare("SELECT payload FROM sources ORDER BY id")
      .all()
      .map((row) => {
        const decoded: unknown = JSON.parse(v.parse(v.string(), row.payload));
        return v.parse(SourceSchema, decoded);
      });
    if (sources.length !== catalog.sourceCount)
      throw new Error("Source catalog accounting mismatch");
    return {
      generatedAt: catalog.generatedAt,
      contacts: catalog.contacts,
      sources,
      municipalities: catalog.municipalities,
      legacy: false,
    };
  }
  const row = v.parse(
    v.object({ payload: v.string() }),
    input.prepare("SELECT payload FROM metadata WHERE key = 'coverage'").get(),
  );
  const value: unknown = JSON.parse(row.payload);
  const metadata = v.parse(
    v.object({
      generated_at: v.string(),
      total_contacts: v.number(),
      sources: v.array(v.unknown()),
    }),
    value,
  );
  return {
    generatedAt: metadata.generated_at,
    contacts: metadata.total_contacts,
    sources: metadata.sources.map(importSource),
    municipalities: [],
    legacy: true,
  };
}

function* readContacts(
  input: DatabaseSync,
  legacy: boolean,
): Generator<Contact> {
  for (const row of input
    .prepare("SELECT payload FROM contacts ORDER BY id")
    .iterate()) {
    const value: unknown = JSON.parse(v.parse(v.string(), row.payload));
    yield legacy ? importContact(value) : v.parse(ContactSchema, value);
  }
}

export function contactRowNumbers(
  contacts: Iterable<Pick<Contact, "id" | "name">>,
): ReadonlyMap<string, number> {
  const order: RowKey[] = [];
  for (const contact of contacts)
    order.push({ normalizedName: normalizeName(contact.name), id: contact.id });
  order.sort(compareRowOrder);
  return new Map(order.map((key, position) => [key.id, position + 1]));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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
  collectionDirectory?: string,
  deltaBases: readonly string[] = [],
  ranking = false,
): Promise<SnapshotResult> {
  const source = resolve(sourcePath);
  const destination = resolve(outputPath);
  if (source.startsWith(`${destination}/`))
    throw new Error("The source must be outside the output directory");
  const deltaSources = await Promise.all(
    deltaBases.map((base) => deltaSource(resolve(base))),
  );
  requireDistinctSources(deltaSources);
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
  const archive = directoryArchiveEncoder();
  const categoryCounts = new Map<string, number>();
  const prefectureCounts = new Map<string, number>();
  const municipalities = new Map<
    string,
    { code: string; prefectureCode: string; name: string }
  >();
  let contacts = 0;
  try {
    const metadata = snapshotInput(input);
    const overlay = collectionDirectory
      ? await readCollectionOverlay(collectionDirectory)
      : { contacts: [], sources: [] };
    const sourceMap = new Map(metadata.sources.map((item) => [item.id, item]));
    for (const source of overlay.sources) {
      const previous = sourceMap.get(source.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(source))
        throw new Error(`Conflicting source identity: ${source.id}`);
      sourceMap.set(source.id, source);
    }
    const sources = Array.from(sourceMap.values()).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    for (const municipality of metadata.municipalities)
      municipalities.set(municipality.code, municipality);
    const municipalityCandidates = new Map<string, Catalog["municipalities"]>();
    for (const item of metadata.municipalities
      .slice()
      .sort((a, b) => b.name.length - a.name.length)) {
      const group = municipalityCandidates.get(item.prefectureCode) ?? [];
      group.push(item);
      municipalityCandidates.set(item.prefectureCode, group);
    }
    const sourceIds = new Set(sources.map((item) => item.id));
    const rowNumbers = contactRowNumbers(
      mergeContacts(readContacts(input, metadata.legacy), overlay.contacts),
    );
    output.exec(databaseSchema);
    output.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; BEGIN",
    );
    const insert = output.prepare(
      "INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const phoneInsert = output.prepare(
      "INSERT OR IGNORE INTO phones VALUES (?, ?)",
    );
    const searchInsert = output.prepare(
      "INSERT INTO contact_search(rowid, terms) VALUES (?, ?)",
    );
    csv.write(contactCsvHeader);
    for (const value of mergeContacts(
      readContacts(input, metadata.legacy),
      overlay.contacts,
    )) {
      const address = normalizeAddress(value.address);
      const prefectureName =
        prefectureNames[Number(value.prefectureCode) - 1] ?? "";
      const municipality = value.municipalityCode
        ? null
        : municipalityCandidates
            .get(value.prefectureCode)
            ?.find(
              (item) =>
                item.prefectureCode === value.prefectureCode &&
                (address.startsWith(`${prefectureName}${item.name}`) ||
                  address.startsWith(item.name)),
            );
      const contact = {
        ...value,
        address,
        municipalityCode: value.municipalityCode ?? municipality?.code ?? null,
      };
      if (!sourceIds.has(contact.sourceId))
        throw new Error(`Missing source: ${contact.sourceId}`);
      if (
        contact.municipalityCode &&
        !contact.municipalityCode.startsWith(contact.prefectureCode)
      )
        throw new Error(`Conflicting region: ${contact.id}`);
      contacts += 1;
      const rowid = rowNumbers.get(contact.id);
      if (rowid === undefined)
        throw new Error(`The contact order changed: ${contact.id}`);
      const normalized = normalizeName(contact.name);
      const folded = searchForm(contact.name);
      const payload = JSON.stringify(contact);
      insert.run(
        rowid,
        contact.id,
        contact.name,
        normalized,
        folded,
        contact.prefectureCode,
        contact.municipalityCode,
        contact.category,
        contact.sourceId,
        payload,
      );
      for (const phone of contact.phones) phoneInsert.run(phone.e164, rowid);
      searchInsert.run(rowid, nameTokens(folded).join(" "));
      archive.add(contact);
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
    if (
      contacts !== metadata.contacts + overlay.contacts.length ||
      contacts !== rowNumbers.size
    )
      throw new Error("The source contact count changed");
    const countedPhones = v.parse(
      v.object({ phones: v.number() }),
      output
        .prepare("SELECT COUNT(DISTINCT number) AS phones FROM phones")
        .get(),
    ).phones;
    const snapshot = hash.digest("hex");
    const catalog: Catalog = v.parse(CatalogSchema, {
      snapshot,
      generatedAt:
        [
          metadata.generatedAt,
          ...overlay.contacts.map((item) => item.retrievedAt),
        ]
          .sort()
          .at(-1) ?? metadata.generatedAt,
      contacts,
      phones: countedPhones,
      sourceCount: sources.length,
      categories: categoryDefinitions
        .filter((category) => (categoryCounts.get(category.id) ?? 0) > 0)
        .map((category) => ({
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
    const searchIndex = readSearchIndex(output, { snapshot, catalog });
    const searchRanking = ranking
      ? await writeSearchRanking(
          destination,
          output,
          decodeSearchIndex(searchIndex),
        )
      : undefined;
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
    const directoryText = archive.finish({ snapshot, catalog, sources });
    const directoryBytes = new TextEncoder().encode(directoryText);
    const directoryPath = join(destination, "directory.tsv");
    await writeFile(directoryPath, directoryBytes, { flag: "wx" });
    const archivePath = join(destination, directoryArchiveFile);
    await pipeline(
      createReadStream(directoryPath),
      createBrotliCompress(
        directoryArchiveCompression(directoryBytes.byteLength),
      ),
      createWriteStream(archivePath, { flags: "wx" }),
    );
    const archiveSha256 = await fileDigest(archivePath);
    const archiveBytes = (await stat(archivePath)).size;
    files.push({
      file: directoryArchiveFile,
      sha256: archiveSha256,
      bytes: archiveBytes,
      url: `/api/datasets/${snapshot}/${archiveSha256}/${directoryArchiveFile}`,
    });
    for (const base of deltaSources)
      if (base.snapshot === snapshot)
        console.info(
          JSON.stringify({
            phase: "directory-delta",
            base: base.snapshot,
            published: false,
            reason: "base-is-target",
          }),
        );
    const deltas = await writeDirectoryDeltas(
      destination,
      { snapshot, archiveSha256, archiveBytes, text: directoryText },
      deltaSources.filter((base) => base.snapshot !== snapshot),
      compressDirectoryArchive,
    );
    const compressedIndex = compressSearchIndex(searchIndex);
    await writeFile(join(destination, searchIndexFile), compressedIndex, {
      flag: "wx",
    });
    const searchIndexArtifact = {
      file: searchIndexFile,
      sha256: sha256Hex(compressedIndex),
      bytes: compressedIndex.byteLength,
      uncompressedSha256: sha256Hex(searchIndex),
      uncompressedBytes: searchIndex.byteLength,
    };
    console.info(
      JSON.stringify({ phase: "search-index", ...searchIndexArtifact }),
    );
    await writeFile(
      join(destination, "catalog.json"),
      `${JSON.stringify(catalog)}\n`,
      { flag: "wx" },
    );
    const manifest = v.parse(PreparedDatasetManifestSchema, {
      snapshot,
      generatedAt: catalog.generatedAt,
      contacts,
      phones: catalog.phones,
      sourceCount: sources.length,
      sourceDatabaseSha256: await fileDigest(source),
      databaseSha256: await fileDigest(join(destination, "directory.sqlite")),
      files,
      searchIndex: searchIndexArtifact,
      ...(searchRanking ? { searchRanking } : {}),
      deltas,
    });
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

export const contactCsvColumns = [
  "id",
  "name",
  "category",
  "prefecture_code",
  "municipality_code",
  "address",
  "phone_numbers",
  "website",
  "source_id",
  "source_url",
  "license",
  "license_url",
  "data_as_of",
] as const;
type ContactCsvColumn = (typeof contactCsvColumns)[number];
const csvRecordDelimiter = "\r\n";
export const contactCsvHeader = `${contactCsvColumns.join(",")}${csvRecordDelimiter}`;
const csvTelephoneSeparator = ";";
const formulaGuard = "'";
/** The leading characters that csv-stringify's `escape_formulas` guards in a string cell. */
const spreadsheetFormulaPrefixes: ReadonlySet<string> = new Set([
  "=",
  "+",
  "-",
  "@",
  "\t",
  "\r",
  "\u{ff1d}",
  "\u{ff0b}",
  "\u{ff0d}",
  "\u{ff20}",
]);

export function guardSpreadsheetFormula(text: string): string {
  return spreadsheetFormulaPrefixes.has(text.charAt(0))
    ? `${formulaGuard}${text}`
    : text;
}

/** Joined E.164 numbers hold only `+`, digits, and `;`, which give a spreadsheet no function, reference, or command. */
export const FormulaInertTelephonesSchema = v.pipe(
  v.array(E164Schema),
  v.minLength(1),
  v.transform((numbers) => numbers.join(csvTelephoneSeparator)),
  v.brand("FormulaInertTelephones"),
);

/** Text always takes the formula guard; only a validated telephone list skips it. */
type CsvCell =
  | string
  | {
      readonly verbatim: v.InferOutput<typeof FormulaInertTelephonesSchema>;
    };

function csvCellText(cell: CsvCell): string {
  return typeof cell === "string"
    ? guardSpreadsheetFormula(cell)
    : cell.verbatim;
}

export function contactCsv(contact: Contact): string {
  const cells: Record<ContactCsvColumn, CsvCell> = {
    id: contact.id,
    name: contact.name,
    category: contact.category,
    prefecture_code: contact.prefectureCode,
    municipality_code: contact.municipalityCode ?? "",
    address: contact.address,
    phone_numbers: {
      verbatim: v.parse(
        FormulaInertTelephonesSchema,
        contact.phones.map((phone) => phone.e164),
      ),
    },
    website: contact.website ?? "",
    source_id: contact.sourceId,
    source_url: contact.sourceUrls.join(" "),
    license: contact.license,
    license_url: contact.licenseUrl,
    data_as_of: contact.dataAsOf,
  };
  return stringify(
    [contactCsvColumns.map((column) => csvCellText(cells[column]))],
    {
      quoted: true,
      quoted_empty: true,
      record_delimiter: csvRecordDelimiter,
    },
  );
}
