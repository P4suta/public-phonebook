import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { DigestSchema } from "../src/core/models.ts";
import {
  ArtifactSchema,
  ArtifactStore,
  type SourceArtifact,
} from "./collection/artifacts.ts";
import { readCollectionOverlay } from "./collection/overlay.ts";
import {
  type CollectionFile,
  CompleteCollectionReportSchema,
  collectionFiles,
  collectionReportFile,
  fileIdentity,
} from "./collection/report.ts";
import {
  type ControlStore,
  controlKeys,
  controlStoreFromEnvironment,
  isConflict,
  readObject,
  sha256Hex,
  writeOnce,
} from "./control-store.ts";
import { encodeRecord } from "./release-store.ts";
import { storeDataset } from "./remote-data.ts";
import { fileDigest } from "./snapshot.ts";

const commandArgumentOffset = 2;
const baseArgumentCount = 2;
const compareArgumentCount = 3;
const storeArgumentCount = 4;
const databaseFile = "directory.sqlite";
const manifestFile = "manifest.ready.json";
const linkFile = "dataset.json";
const linkFormat = 1;
const reportedFiles = [...collectionFiles, collectionReportFile] as const;
export const basePinFile = "sources/base-dataset.json";

const CountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const BaseDatasetPinSchema = v.pipe(
  v.strictObject({
    manifestSha256: DigestSchema,
    database: v.strictObject({
      key: v.string(),
      sha256: DigestSchema,
      bytes: v.pipe(CountSchema, v.minValue(1)),
    }),
  }),
  v.check(
    (pin) => pin.database.key === controlKeys.blob(pin.database.sha256),
    "The base database key must name the database digest",
  ),
);
export type BaseDatasetPin = v.InferOutput<typeof BaseDatasetPinSchema>;

const DatasetManifestSchema = v.object({
  databaseSha256: DigestSchema,
  contacts: CountSchema,
});
const PreparedManifestSchema = v.object({
  sourceDatabaseSha256: DigestSchema,
  contacts: CountSchema,
});

export type CollectionStoreCommand =
  | { readonly kind: "base"; readonly directory: string }
  | {
      readonly kind: "compare";
      readonly collection: string;
      readonly replay: string;
    }
  | {
      readonly kind: "store";
      readonly collection: string;
      readonly cache: string;
      readonly dataset: string;
    };

const usage =
  "Usage: collection-store base DIRECTORY | collection-store compare COLLECTION REPLAY | collection-store store COLLECTION CACHE DATASET";

export function parseCollectionStoreArguments(
  args: readonly string[],
): CollectionStoreCommand {
  const [command, first, second, third] = args;
  if (command === "base" && first && args.length === baseArgumentCount)
    return { kind: "base", directory: resolve(first) };
  if (
    command === "compare" &&
    first &&
    second &&
    args.length === compareArgumentCount
  )
    return {
      kind: "compare",
      collection: resolve(first),
      replay: resolve(second),
    };
  if (
    command === "store" &&
    first &&
    second &&
    third &&
    args.length === storeArgumentCount
  )
    return {
      kind: "store",
      collection: resolve(first),
      cache: resolve(second),
      dataset: resolve(third),
    };
  throw new Error(usage);
}

export async function readBasePin(
  path: string = basePinFile,
): Promise<BaseDatasetPin> {
  const decoded: unknown = JSON.parse(await readFile(path, "utf8"));
  return v.parse(BaseDatasetPinSchema, decoded);
}

async function baseManifest(
  store: ControlStore,
  pin: BaseDatasetPin,
): Promise<v.InferOutput<typeof DatasetManifestSchema>> {
  const object = await readObject(
    store,
    controlKeys.dataset(pin.manifestSha256, manifestFile),
  );
  if (!object)
    throw new Error("The control store has no manifest for the base dataset");
  if (sha256Hex(object.body) !== pin.manifestSha256)
    throw new Error("The base dataset manifest differs from its pin");
  const decoded: unknown = JSON.parse(new TextDecoder().decode(object.body));
  const manifest = v.parse(DatasetManifestSchema, decoded);
  if (manifest.databaseSha256 !== pin.database.sha256)
    throw new Error("The base dataset manifest names another database");
  return manifest;
}

export async function fetchBaseDatabase(
  store: ControlStore,
  pin: BaseDatasetPin,
  directory: string,
): Promise<string> {
  await baseManifest(store, pin);
  await mkdir(directory, { recursive: true });
  const path = join(directory, databaseFile);
  const fetched = await store.download(pin.database.key, path);
  if (!fetched) throw new Error("The control store has no base database");
  if (
    fetched.bytes !== pin.database.bytes ||
    (await fileDigest(path)) !== pin.database.sha256
  ) {
    await rm(path, { force: true });
    throw new Error("The base database differs from its pin");
  }
  return path;
}

export async function requireIdenticalCollections(
  collection: string,
  replay: string,
): Promise<void> {
  const differing: string[] = [];
  for (const file of reportedFiles) {
    const [first, second] = await Promise.all([
      readFile(join(collection, file)),
      readFile(join(replay, file)),
    ]);
    if (!first.equals(second)) differing.push(file);
  }
  if (differing.length)
    throw new Error(
      `The offline replay differs from the collection: ${differing.join(", ")}`,
    );
}

export interface VerifiedCollection {
  readonly report: string;
  readonly contacts: number;
  readonly files: Readonly<
    Record<CollectionFile | typeof collectionReportFile, Uint8Array>
  >;
  readonly artifacts: readonly SourceArtifact[];
}

export async function verifyCollection(
  directory: string,
  cache: string,
): Promise<VerifiedCollection> {
  const read = async (file: string): Promise<Uint8Array> =>
    new Uint8Array(await readFile(join(directory, file)));
  const reportBytes = await read(collectionReportFile);
  const decoded: unknown = JSON.parse(new TextDecoder().decode(reportBytes));
  const report = v.parse(CompleteCollectionReportSchema, decoded);
  const files = {
    "contacts.jsonl": await read("contacts.jsonl"),
    "sources.json": await read("sources.json"),
    "artifacts.json": await read("artifacts.json"),
    [collectionReportFile]: reportBytes,
  };
  for (const file of collectionFiles) {
    const actual = fileIdentity(files[file]);
    if (
      actual.sha256 !== report.files[file].sha256 ||
      actual.bytes !== report.files[file].bytes
    )
      throw new Error(`A collection file differs from its report: ${file}`);
  }
  const overlay = await readCollectionOverlay(directory);
  const listed: unknown = JSON.parse(
    new TextDecoder().decode(files["artifacts.json"]),
  );
  const artifacts = v.parse(v.array(ArtifactSchema), listed);
  if (
    new Set(artifacts.map((artifact) => artifact.url)).size !== artifacts.length
  )
    throw new Error("The collection lists a source URL twice");
  const located = new Set(
    artifacts.map((artifact) => `${artifact.url} ${artifact.sha256}`),
  );
  for (const source of overlay.sources)
    for (const artifact of source.artifacts)
      if (!located.has(`${artifact.url} ${artifact.sha256}`))
        throw new Error(
          `The collection cache lacks a cited source artifact: ${artifact.url}`,
        );
  const reader = new ArtifactStore(cache, { offline: true });
  for (const artifact of artifacts) await reader.read(artifact);
  return {
    report: sha256Hex(reportBytes),
    contacts: report.contacts,
    files,
    artifacts,
  };
}

export interface StoredCollection {
  readonly report: string;
  readonly manifestSha256: string;
  readonly contacts: number;
  readonly artifacts: number;
}

export async function storeCollection(
  store: ControlStore,
  input: {
    readonly collection: string;
    readonly cache: string;
    readonly dataset: string;
    readonly pin: BaseDatasetPin;
  },
): Promise<StoredCollection> {
  const collection = await verifyCollection(input.collection, input.cache);
  const base = await baseManifest(store, input.pin);
  const manifestPath = join(input.dataset, manifestFile);
  const manifestSha256 = await fileDigest(manifestPath);
  const decoded: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const prepared = v.parse(PreparedManifestSchema, decoded);
  if (prepared.sourceDatabaseSha256 !== input.pin.database.sha256)
    throw new Error(
      "The dataset wasn't prepared from the pinned base database",
    );
  if (prepared.contacts !== base.contacts + collection.contacts)
    throw new Error(
      "The dataset doesn't hold exactly the base and collection contacts",
    );
  const objects = new Map(
    collection.artifacts.map((artifact) => [artifact.sha256, artifact.bytes]),
  );
  for (const [sha256, bytes] of objects) {
    const key = controlKeys.collectionCache(sha256);
    if (await store.head(key)) continue;
    try {
      await store.write(
        key,
        { path: join(resolve(input.cache), "objects", sha256), bytes, sha256 },
        { kind: "create" },
      );
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
  for (const file of reportedFiles)
    await writeOnce(
      store,
      controlKeys.collection(collection.report, file),
      collection.files[file],
    );
  await writeOnce(
    store,
    controlKeys.collection(collection.report, linkFile),
    encodeRecord({
      formatVersion: linkFormat,
      report: collection.report,
      base: {
        manifestSha256: input.pin.manifestSha256,
        databaseSha256: input.pin.database.sha256,
      },
      manifestSha256,
    }),
  );
  if ((await storeDataset(store, input.dataset)) !== manifestSha256)
    throw new Error("The dataset manifest changed while it was stored");
  return {
    report: collection.report,
    manifestSha256,
    contacts: prepared.contacts,
    artifacts: objects.size,
  };
}

async function main(args: readonly string[]): Promise<void> {
  const command = parseCollectionStoreArguments(args);
  if (command.kind === "compare") {
    await requireIdenticalCollections(command.collection, command.replay);
    console.info(
      JSON.stringify({ operation: "collection.compare", result: "identical" }),
    );
    return;
  }
  const pin = await readBasePin();
  const store = controlStoreFromEnvironment();
  if (command.kind === "base") {
    await fetchBaseDatabase(store, pin, command.directory);
    console.info(
      JSON.stringify({
        operation: "collection.base",
        manifestSha256: pin.manifestSha256,
        databaseSha256: pin.database.sha256,
        bytes: pin.database.bytes,
        result: "verified",
      }),
    );
    return;
  }
  console.info(
    JSON.stringify({
      operation: "collection.store",
      ...(await storeCollection(store, { ...command, pin })),
      result: "stored",
    }),
  );
}

if (import.meta.main) await main(process.argv.slice(commandArgumentOffset));
