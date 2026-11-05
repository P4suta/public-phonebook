import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { brotliDecompressSync } from "node:zlib";
import * as v from "valibot";
import { normalizeAddress } from "../src/core/address.ts";
import {
  type PreparedDatasetManifest,
  PreparedDatasetManifestSchema,
} from "../src/core/dataset-storage.ts";
import {
  directoryArchiveEncoder,
  directoryArchiveFile,
} from "../src/core/directory-archive.ts";
import {
  decodeDirectoryDelta,
  deltaMatchesTarget,
} from "../src/core/directory-delta.ts";
import { deltaPublication } from "../src/core/directory-delta-policy.ts";
import { normalizeName } from "../src/core/identity.ts";
import {
  CatalogSchema,
  ContactSchema,
  DigestSchema,
  type Source,
  SourceSchema,
} from "../src/core/models.ts";
import { encodePackedRanking } from "../src/core/packed-ranking.ts";
import { decodeSearchIndex } from "../src/core/search-index.ts";
import {
  decodeRankingArtifact,
  encodeRankingArtifact,
} from "../src/core/search-ranking-artifact.ts";
import { searchForm } from "../src/core/search-text.ts";
import { readGzipArchive } from "./archive-stream.ts";
import { decodeUtf8, requireDirectoryText } from "./directory-delta.ts";
import { command } from "./process.ts";
import { checkRowOrder, readSearchIndex } from "./search-index.ts";
import {
  buildRankingArtifact,
  generateRankingReadings,
  rankingAliases,
} from "./search-ranking.ts";
import { fileDigest } from "./snapshot.ts";
import {
  stageInputDigest,
  type TrackedFile,
  trackedFiles,
} from "./stage-inputs.ts";
import { type ArchiveForms, checkTelephoneParity } from "./telephone-parity.ts";

const commandArgumentOffset = 2;
const manifestFile = "manifest.ready.json";
const dataCheckFormat = 1;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Checks each delta's digests, size rule, target identity, header line, and literal rows. */
async function checkDirectoryDeltas(
  directory: string,
  manifest: PreparedDatasetManifest,
  expectedArchive: Uint8Array,
): Promise<void> {
  const archive = manifest.files.find(
    (file) => file.file === directoryArchiveFile,
  );
  if (!archive) throw new Error("The manifest has no directory archive");
  const target = requireDirectoryText(
    decodeUtf8(expectedArchive, "directory archive"),
  );
  const identity = {
    snapshot: manifest.snapshot,
    archiveSha256: archive.sha256,
    sha256: sha256Hex(expectedArchive),
    bytes: expectedArchive.byteLength,
  };
  for (const artifact of manifest.deltas) {
    let bytes: Uint8Array;
    try {
      bytes = brotliDecompressSync(
        await readFile(join(directory, artifact.file)),
        { maxOutputLength: artifact.uncompressedBytes },
      );
    } catch (error) {
      throw new Error(
        `Directory delta exceeds its manifest: ${artifact.file}`,
        {
          cause: error,
        },
      );
    }
    const delta = decodeDirectoryDelta(decodeUtf8(bytes, "directory delta"));
    if (
      bytes.byteLength !== artifact.uncompressedBytes ||
      sha256Hex(bytes) !== artifact.uncompressedSha256 ||
      !delta.ok ||
      delta.value.header.base.snapshot !== artifact.base ||
      delta.value.header.base.archiveSha256 !== artifact.baseArchiveSha256 ||
      !deltaPublication(artifact.bytes, archive.bytes) ||
      !deltaMatchesTarget(delta.value, target, identity)
    )
      throw new Error(
        `Directory delta differs from its directory: ${artifact.file}`,
      );
  }
}

export async function checkDataBundle(
  directory: string,
  forms: ArchiveForms = "canonical",
): Promise<PreparedDatasetManifest> {
  const decoded: unknown = JSON.parse(
    await readFile(join(directory, "manifest.ready.json"), "utf8"),
  );
  const manifest = v.parse(PreparedDatasetManifestSchema, decoded);
  const path = join(directory, "directory.sqlite");
  if ((await fileDigest(path)) !== manifest.databaseSha256)
    throw new Error("Database checksum mismatch");
  for (const file of [
    ...manifest.files,
    manifest.searchIndex,
    ...(manifest.searchRanking ? [manifest.searchRanking] : []),
    ...manifest.deltas,
  ])
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
    const sourceRecords: Source[] = [];
    for (const row of db.prepare("SELECT id, payload FROM sources").iterate()) {
      const value: unknown = JSON.parse(v.parse(v.string(), row.payload));
      const source = v.parse(SourceSchema, value);
      if (source.id !== row.id) throw new Error("Source index mismatch");
      sources.add(source.id);
      sourceRecords.push(source);
    }
    const archive = directoryArchiveEncoder();
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
        forms === "canonical" &&
        normalizeAddress(contact.address) !== contact.address
      )
        throw new Error(`Noncanonical address: ${contact.id}`);
      if (
        row.id !== contact.id ||
        row.name !== contact.name ||
        row.normalized_name !== normalizeName(contact.name) ||
        row.folded_name !== searchForm(contact.name) ||
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
      archive.add(contact);
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
    for await (const chunk of readGzipArchive(
      join(directory, "contacts.jsonl.gz"),
    )) {
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
    await checkTelephoneParity(directory, forms);
    const expectedArchive = new TextEncoder().encode(
      archive.finish({
        snapshot: manifest.snapshot,
        catalog,
        sources: sourceRecords,
      }),
    );
    const compressedArchive = await readFile(
      join(directory, directoryArchiveFile),
    );
    let actualArchive: Uint8Array;
    try {
      actualArchive = brotliDecompressSync(compressedArchive, {
        maxOutputLength: expectedArchive.length,
      });
    } catch (error) {
      throw new Error("Directory archive exceeds its directory", {
        cause: error,
      });
    }
    if (
      actualArchive.byteLength !== expectedArchive.byteLength ||
      createHash("sha256").update(actualArchive).digest("hex") !==
        createHash("sha256").update(expectedArchive).digest("hex")
    )
      throw new Error("Directory archive differs from its directory");
    await checkDirectoryDeltas(directory, manifest, expectedArchive);
    checkRowOrder(db);
    const expectedIndex = readSearchIndex(db, {
      snapshot: manifest.snapshot,
      catalog,
    });
    let actualIndex: Uint8Array;
    try {
      actualIndex = brotliDecompressSync(
        await readFile(join(directory, manifest.searchIndex.file)),
        { maxOutputLength: expectedIndex.byteLength },
      );
    } catch (error) {
      throw new Error("Search index exceeds its directory", { cause: error });
    }
    if (
      actualIndex.byteLength !== expectedIndex.byteLength ||
      sha256Hex(actualIndex) !== sha256Hex(expectedIndex) ||
      manifest.searchIndex.uncompressedBytes !== expectedIndex.byteLength ||
      manifest.searchIndex.uncompressedSha256 !== sha256Hex(expectedIndex)
    )
      throw new Error("Search index differs from its directory");
    if (manifest.searchRanking) {
      const artifact = manifest.searchRanking;
      const actual = brotliDecompressSync(
        await readFile(join(directory, artifact.file)),
        {
          maxOutputLength: artifact.uncompressedBytes,
        },
      );
      decodeRankingArtifact(actual, manifest.snapshot, manifest.contacts);
      const index = decodeSearchIndex(expectedIndex);
      const readings = await generateRankingReadings(
        index.rows.map((row) => row.name),
      );
      const built = buildRankingArtifact(
        index,
        readings,
        await rankingAliases(db),
      );
      const canonical = encodeRankingArtifact(built);
      const expected =
        artifact.format === "public-phonebook-search-ranking/2"
          ? encodePackedRanking(index, built, sha256Hex(canonical))
          : canonical;
      if (
        actual.byteLength !== artifact.uncompressedBytes ||
        sha256Hex(actual) !== artifact.uncompressedSha256 ||
        expected.byteLength !== actual.byteLength ||
        sha256Hex(expected) !== sha256Hex(actual)
      )
        throw new Error(
          "Search ranking differs from its directory and pinned readings",
        );
    }
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
        searchIndexBytes: manifest.searchIndex.bytes,
        searchRankingBytes: manifest.searchRanking?.bytes ?? null,
        integrity: integrity.integrity_check,
        forms,
      }),
    );
    return manifest;
  } finally {
    db.close();
  }
}

const CheckedFileSchema = v.strictObject({
  file: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9._-]*$/u)),
  bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  sha256: DigestSchema,
});
export type CheckedFile = v.InferOutput<typeof CheckedFileSchema>;

const DataCheckReceiptSchema = v.strictObject({
  formatVersion: v.literal(dataCheckFormat),
  key: DigestSchema,
  files: v.pipe(v.array(CheckedFileSchema), v.minLength(1)),
  result: v.literal("passed"),
});

/** Names every bundle file that `checkDataBundle` reads. */
export function checkedFileNames(
  manifest: PreparedDatasetManifest,
): readonly string[] {
  return [
    manifestFile,
    "catalog.json",
    "directory.sqlite",
    ...manifest.files.map((file) => file.file),
    manifest.searchIndex.file,
    ...(manifest.searchRanking ? [manifest.searchRanking.file] : []),
    ...manifest.deltas.map((delta) => delta.file),
  ].sort();
}

/** Keys a check by the data stage's inputs, which cover the checker's tracked files and the manifest, and by the address forms it admits. */
export function dataCheckKey(
  files: readonly TrackedFile[],
  manifestSha256: string,
  forms: ArchiveForms,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        formatVersion: dataCheckFormat,
        inputsSha256: stageInputDigest("data", files, manifestSha256),
        forms,
      }),
    )
    .digest("hex");
}

function sameFiles(
  left: readonly CheckedFile[],
  right: readonly CheckedFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every((file, index) => {
      const other = right[index];
      return (
        other?.file === file.file &&
        other.bytes === file.bytes &&
        other.sha256 === file.sha256
      );
    })
  );
}

function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Reuses a passing check only when its receipt names this key and every file the check read keeps its recorded size and SHA-256. */
export function reusesDataCheck(
  key: string,
  receipt: string | null,
  observed: readonly CheckedFile[],
): boolean {
  if (receipt === null) return false;
  const parsed = v.safeParse(DataCheckReceiptSchema, decodeJson(receipt));
  return (
    parsed.success &&
    parsed.output.key === key &&
    sameFiles(parsed.output.files, observed)
  );
}

interface ObservedBundle {
  readonly manifest: PreparedDatasetManifest;
  readonly manifestSha256: string;
  readonly files: readonly CheckedFile[];
}

/** Hashes every file the check reads, or returns `null` for a manifest that only the complete check can explain. */
async function observeBundle(
  directory: string,
): Promise<ObservedBundle | null> {
  const bytes = await readFile(join(directory, manifestFile));
  const manifest = v.safeParse(
    PreparedDatasetManifestSchema,
    decodeJson(bytes.toString("utf8")),
  );
  if (!manifest.success) return null;
  const manifestSha256 = sha256Hex(bytes);
  const files: CheckedFile[] = [];
  for (const file of checkedFileNames(manifest.output)) {
    const path = join(directory, file);
    files.push(
      file === manifestFile
        ? { file, bytes: bytes.byteLength, sha256: manifestSha256 }
        : {
            file,
            bytes: (await stat(path)).size,
            sha256: await fileDigest(path),
          },
    );
  }
  return { manifest: manifest.output, manifestSha256, files };
}

export interface DataCheckPorts {
  /** Lists the tracked files of a clean checkout, or returns `null` when no committed tree identifies the checker. */
  readonly sourceFiles: () => Promise<readonly TrackedFile[] | null>;
  readonly receipts: string;
  readonly check: typeof checkDataBundle;
}

async function cleanTrackedFiles(): Promise<readonly TrackedFile[] | null> {
  const status = await command("git", ["status", "--porcelain"], true);
  return status.code === 0 && !status.stdout.trim() ? trackedFiles() : null;
}

async function readReceipt(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

/** Runs the complete check, or reuses this checkout's passing result for the same key and the same bytes of every file the check reads. */
export async function checkedDataBundle(
  directory: string,
  forms: ArchiveForms = "canonical",
  ports: DataCheckPorts = {
    sourceFiles: cleanTrackedFiles,
    receipts: resolve(".local/receipts/data-check"),
    check: checkDataBundle,
  },
): Promise<PreparedDatasetManifest> {
  const source = await ports.sourceFiles();
  const before = source ? await observeBundle(directory) : null;
  if (!source || !before) return ports.check(directory, forms);
  const key = dataCheckKey(source, before.manifestSha256, forms);
  const path = join(ports.receipts, `${key}.json`);
  if (reusesDataCheck(key, await readReceipt(path), before.files)) {
    console.info(
      JSON.stringify({
        operation: "data.check",
        result: "reused",
        key,
        snapshot: before.manifest.snapshot,
        files: before.files.length,
        forms,
      }),
    );
    return before.manifest;
  }
  const manifest = await ports.check(directory, forms);
  const after = await observeBundle(directory);
  if (!after || !sameFiles(before.files, after.files))
    throw new Error("The dataset changed during its check");
  const receipt = v.parse(DataCheckReceiptSchema, {
    formatVersion: dataCheckFormat,
    key,
    files: before.files,
    result: "passed",
  });
  await mkdir(ports.receipts, { recursive: true });
  await writeFile(path, JSON.stringify(receipt), { flush: true });
  return manifest;
}

if (import.meta.main) {
  const [directory, ...extra] = process.argv.slice(commandArgumentOffset);
  if (!directory || extra.length)
    throw new Error("Usage: npm run data:check -- BUNDLE_DIRECTORY");
  await checkedDataBundle(resolve(directory));
}
