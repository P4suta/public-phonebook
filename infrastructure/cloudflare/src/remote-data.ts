import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cloudflare, remoteSql } from "@public-phonebook/cloudflare/cloudflare";
import {
  acquireLease,
  type PublicationLease,
} from "@public-phonebook/cloudflare/control-lease";
import {
  type ControlStore,
  controlKeys,
  controlStoreFromEnvironment,
  isConflict,
  type RemoteEnvironment,
  readObject,
  SequenceSchema,
  sha256Hex,
  writeOnce,
} from "@public-phonebook/cloudflare/control-store";
import {
  type ImportIdentity,
  importIdentity,
} from "@public-phonebook/cloudflare/import-identity";
import { publicationBinding } from "@public-phonebook/cloudflare/release-lifecycle";
import {
  activeDatabaseId,
  deployedVersions,
} from "@public-phonebook/cloudflare/release-provider";
import {
  encodeRecord,
  loadRelease,
  RemoteEnvironmentSchema,
  type RunProvenance,
  RunProvenanceSchema,
  runProvenance,
  storeVerificationDataset,
} from "@public-phonebook/cloudflare/release-store";
import {
  checkImportIdentity,
  RemoteCountsSchema,
  type SeedResult,
  seedDatabase,
  type VerificationFacts,
} from "@public-phonebook/cloudflare/seed-database";
import { checkedProductionDataBundle } from "@public-phonebook/data/check-data";
import { fileDigest } from "@public-phonebook/data/snapshot";
import { manifestObjectKey } from "@public-phonebook/directory/dataset-storage";
import {
  databaseResourceName,
  environments,
} from "@public-phonebook/directory/environment";
import { DigestSchema } from "@public-phonebook/directory/models";
import * as v from "valibot";
import { ProductionDatasetSchema, productionDataset } from "../dataset.ts";

const prepareArgumentCount = 2;
const fetchArgumentCount = 3;
const storeArgumentCount = 2;
const jsonIndentation = 2;
const commandArgumentOffset = 2;
const databaseFile = "directory.sqlite";
const remoteDataDirectory = ".local/remote-data";

export type RemoteDataCommand =
  | {
      readonly kind: "prepare";
      readonly environment: RemoteEnvironment;
      readonly bundle: string;
    }
  | {
      readonly kind: "fetch";
      readonly manifestSha256: string;
      readonly directory: string;
    }
  | { readonly kind: "store"; readonly bundle: string };

const usage =
  "Usage: remote-data ENVIRONMENT BUNDLE | remote-data --fetch MANIFEST_SHA256 DIRECTORY | remote-data --fetch-production DIRECTORY | remote-data --store BUNDLE";

export function parseRemoteDataArguments(
  args: readonly string[],
): RemoteDataCommand {
  const [first, second, third] = args;
  if (
    first === "--fetch-production" &&
    second &&
    args.length === prepareArgumentCount
  )
    return {
      kind: "fetch",
      manifestSha256: productionDataset.manifestSha256,
      directory: resolve(second),
    };
  if (
    first === "--fetch" &&
    second &&
    third &&
    args.length === fetchArgumentCount
  )
    return {
      kind: "fetch",
      manifestSha256: v.parse(DigestSchema, second),
      directory: resolve(third),
    };
  if (first === "--store" && second && args.length === storeArgumentCount)
    return { kind: "store", bundle: resolve(second) };
  const environment = v.safeParse(RemoteEnvironmentSchema, first);
  if (environment.success && second && args.length === prepareArgumentCount)
    return {
      kind: "prepare",
      environment: environment.output,
      bundle: resolve(second),
    };
  throw new Error(usage);
}

export function mayCreateBucket(provenance: RunProvenance): boolean {
  return provenance.kind === "local";
}

const RetainedFileSchema = v.object({
  file: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9._-]*$/u)),
  sha256: DigestSchema,
  bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const RetainedManifestSchema = v.object({
  snapshot: DigestSchema,
  databaseSha256: DigestSchema,
  files: v.array(RetainedFileSchema),
  searchIndex: v.optional(RetainedFileSchema),
  searchRanking: v.optional(RetainedFileSchema),
  deltas: v.optional(v.array(RetainedFileSchema), []),
});
const ProductionManifestSchema = v.pipe(
  RetainedManifestSchema,
  v.check(
    (manifest) =>
      manifest.searchRanking === undefined &&
      [
        ...manifest.files,
        ...manifest.deltas,
        ...(manifest.searchIndex ? [manifest.searchIndex] : []),
      ].every((file) => !file.file.startsWith("search-ranking")),
    "Production datasets must omit ranking companions",
  ),
);
type RetainedFile = v.InferOutput<typeof RetainedFileSchema>;

function datasetFiles(
  manifest: v.InferOutput<typeof RetainedManifestSchema>,
): readonly RetainedFile[] {
  return [
    ...manifest.files,
    ...(manifest.searchIndex ? [manifest.searchIndex] : []),
    ...manifest.deltas,
  ];
}

async function bundleFiles(bundle: string): Promise<readonly RetainedFile[]> {
  const manifest = v.parse(
    ProductionManifestSchema,
    JSON.parse(await readFile(join(bundle, "manifest.ready.json"), "utf8")),
  );
  return [
    ...datasetFiles(manifest),
    {
      file: databaseFile,
      sha256: manifest.databaseSha256,
      bytes: (await stat(join(bundle, databaseFile))).size,
    },
  ];
}

export async function storeDataset(
  store: ControlStore,
  bundle: string,
): Promise<string> {
  for (const file of await bundleFiles(bundle)) {
    const path = join(bundle, file.file);
    if ((await fileDigest(path)) !== file.sha256)
      throw new Error(`A dataset file differs from its manifest: ${file.file}`);
    const key = controlKeys.blob(file.sha256);
    if (await store.head(key)) continue;
    try {
      await store.write(
        key,
        { path, bytes: file.bytes, sha256: file.sha256 },
        { kind: "create" },
      );
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
  return storeVerificationDataset(store, bundle);
}

export async function fetchDataset(
  store: ControlStore,
  manifestSha256: string,
  directory: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const manifestObject = await readObject(
    store,
    controlKeys.dataset(manifestSha256, "manifest.ready.json"),
  );
  const catalogObject = await readObject(
    store,
    controlKeys.dataset(manifestSha256, "catalog.json"),
  );
  if (!manifestObject || !catalogObject)
    throw new Error("The control store has no such dataset");
  if (sha256Hex(manifestObject.body) !== manifestSha256)
    throw new Error("The stored manifest differs from its digest");
  const manifest = v.parse(
    ProductionManifestSchema,
    JSON.parse(new TextDecoder().decode(manifestObject.body)),
  );
  await writeFile(join(directory, "manifest.ready.json"), manifestObject.body);
  await writeFile(join(directory, "catalog.json"), catalogObject.body);
  for (const file of [
    ...datasetFiles(manifest),
    { file: databaseFile, sha256: manifest.databaseSha256, bytes: null },
  ]) {
    const path = join(directory, file.file);
    const fetched = await store.download(controlKeys.blob(file.sha256), path);
    if (
      !fetched ||
      (file.bytes !== null && fetched.bytes !== file.bytes) ||
      (await fileDigest(path)) !== file.sha256
    ) {
      await rm(path, { force: true });
      throw new Error(
        `A fetched dataset file differs from its manifest: ${file.file}`,
      );
    }
  }
  return directory;
}

export async function writeArchives(
  bucket: ControlStore,
  bundle: string,
  lease: Pick<PublicationLease, "assertHeld">,
): Promise<readonly string[]> {
  const manifest = v.parse(
    ProductionManifestSchema,
    JSON.parse(await readFile(join(bundle, "manifest.ready.json"), "utf8")),
  );
  const manifestPath = join(bundle, "manifest.ready.json");
  const manifestSha256 = await fileDigest(manifestPath);
  const objects = [
    ...datasetFiles(manifest).map((file) => ({
      key: `${manifest.snapshot}/${file.sha256}/${file.file}`,
      body: {
        path: join(bundle, file.file),
        bytes: file.bytes,
        sha256: file.sha256,
      },
    })),
    {
      key: manifestObjectKey(manifest.snapshot, manifestSha256),
      body: {
        path: manifestPath,
        bytes: (await stat(manifestPath)).size,
        sha256: manifestSha256,
      },
    },
  ];
  const written: string[] = [];
  for (const object of objects) {
    lease.assertHeld();
    if ((await fileDigest(object.body.path)) !== object.body.sha256)
      throw new Error(`An archive differs from its manifest: ${object.key}`);
    try {
      await bucket.write(object.key, object.body, { kind: "create" });
      written.push(object.key);
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
  return written;
}

const databaseEvidenceFormat = 2;
export const DatabaseEvidenceSchema = v.strictObject({
  formatVersion: v.literal(databaseEvidenceFormat),
  environment: RemoteEnvironmentSchema,
  databaseSha256: DigestSchema,
  transformationSha256: DigestSchema,
  importSha256: DigestSchema,
  database: v.pipe(v.string(), v.uuid()),
  verification: v.variant("source", [
    v.strictObject({
      source: v.literal("verification"),
      counts: RemoteCountsSchema,
    }),
    v.strictObject({
      source: v.literal("publication"),
      sequence: SequenceSchema,
      releaseId: v.pipe(v.string(), v.uuid()),
    }),
  ]),
  provenance: RunProvenanceSchema,
});
export type DatabaseEvidence = v.InferOutput<typeof DatabaseEvidenceSchema>;

export async function readDatabaseEvidence(
  store: ControlStore,
  environment: RemoteEnvironment,
  importSha256: string,
  databaseId: string,
): Promise<DatabaseEvidence | null> {
  const object = await readObject(
    store,
    controlKeys.databaseEvidence(importSha256, databaseId),
  );
  if (!object) return null;
  const evidence = v.parse(
    DatabaseEvidenceSchema,
    JSON.parse(new TextDecoder().decode(object.body)),
  );
  if (evidence.environment !== environment)
    throw new Error("The database evidence belongs to another environment");
  return evidence;
}

export interface DatabaseFacts {
  readonly verification: VerificationFacts;
  readonly journalSequence: number;
  readonly verifiedRelease: string | null;
}

type DatabaseBindings = (
  environment: RemoteEnvironment,
) => Promise<ReadonlySet<string>>;

async function liveDatabaseBindings(
  environment: RemoteEnvironment,
): Promise<ReadonlySet<string>> {
  const deployed = await deployedVersions(environment);
  const versions = [
    deployed.current,
    ...(deployed.candidate ? [deployed.candidate] : []),
  ];
  return new Set(
    await Promise.all(
      versions.map((version) =>
        activeDatabaseId(environment, version.versionId),
      ),
    ),
  );
}

/** Reads live bindings before deciding whether preparation may scan or write a database. */
export async function databaseFacts(
  store: ControlStore,
  environment: RemoteEnvironment,
  identity: ImportIdentity,
  databaseId: string,
  bindings: DatabaseBindings = liveDatabaseBindings,
): Promise<DatabaseFacts> {
  const bound = (await bindings(environment)).has(databaseId);
  const head = await loadRelease(store, environment);
  const verifiedRelease =
    bound && head
      ? publicationBinding(head.journal, identity.databaseSha256, databaseId)
          .verifiedRelease
      : null;
  return {
    verification: {
      importSha256: identity.importSha256,
      resource: databaseId,
      evidence: await readDatabaseEvidence(
        store,
        environment,
        identity.importSha256,
        databaseId,
      ),
      bound,
      publicationVerified: verifiedRelease !== null,
    },
    journalSequence: head?.record.sequence ?? 0,
    verifiedRelease,
  };
}

/** Records a full verification, or the publication whose staging required one, once for the database's import identity and resource. */
export async function recordDatabaseVerification(
  store: ControlStore,
  environment: RemoteEnvironment,
  identity: ImportIdentity,
  facts: DatabaseFacts,
  seeded: SeedResult,
  provenance: RunProvenance,
): Promise<DatabaseEvidence | null> {
  if (seeded.verification === "accept-evidence") return null;
  if (identity.importSha256 !== facts.verification.importSha256)
    throw new Error("The database facts belong to another import identity");
  const evidence = v.parse(DatabaseEvidenceSchema, {
    formatVersion: databaseEvidenceFormat,
    environment,
    ...identity,
    database: facts.verification.resource,
    verification:
      seeded.verification === "verify"
        ? { source: "verification", counts: seeded.counts }
        : {
            source: "publication",
            sequence: facts.journalSequence,
            releaseId: facts.verifiedRelease,
          },
    provenance,
  });
  await writeOnce(
    store,
    controlKeys.databaseEvidence(evidence.importSha256, evidence.database),
    encodeRecord(evidence),
  );
  return evidence;
}

async function prepareBucket(
  environment: RemoteEnvironment,
  provenance: RunProvenance,
): Promise<void> {
  if (!mayCreateBucket(provenance)) return;
  const target = environments[environment];
  const buckets = v.parse(
    v.object({ buckets: v.array(v.object({ name: v.string() })) }),
    await cloudflare([
      "r2",
      "buckets",
      "list",
      "--name-contains",
      target.bucket,
      "--per-page",
      "100",
    ]),
  );
  if (!buckets.buckets.some((bucket) => bucket.name === target.bucket))
    await cloudflare([
      "r2",
      "buckets",
      "create",
      "--name",
      target.bucket,
      "--location-hint",
      "apac",
    ]);
}

async function prepare(
  environment: RemoteEnvironment,
  bundle: string,
): Promise<void> {
  v.parse(
    v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/u)),
    process.env.CLOUDFLARE_ACCOUNT_ID,
  );
  const directory = resolve(remoteDataDirectory);
  await mkdir(directory, { recursive: true });
  const provenance = runProvenance();
  const lease = await acquireLease(
    controlStoreFromEnvironment(),
    environment,
    provenance,
  );
  try {
    const manifest = await checkedProductionDataBundle(bundle);
    const manifestSha256 = await fileDigest(
      join(bundle, "manifest.ready.json"),
    );
    const target = environments[environment];
    const identity = importIdentity(manifest.databaseSha256);
    const databaseName = databaseResourceName(
      environment,
      identity.importSha256,
    );
    const list = v.parse(
      v.array(v.object({ name: v.string(), uuid: v.string() })),
      await cloudflare([
        "d1",
        "list",
        "--name",
        databaseName,
        "--per-page",
        "100",
      ]),
    );
    const matches = list.filter((database) => database.name === databaseName);
    if (matches.length > 1) throw new Error("Ambiguous database identity");
    lease.assertHeld();
    const database =
      matches[0] ??
      v.parse(
        v.object({ name: v.literal(databaseName), uuid: v.string() }),
        await cloudflare([
          "d1",
          "create",
          "--name",
          databaseName,
          "--primary-location-hint",
          "apac",
          "--read-replication-mode",
          "disabled",
        ]),
      );
    const control = controlStoreFromEnvironment();
    const facts = await databaseFacts(
      control,
      environment,
      identity,
      database.uuid,
    );
    const sql = remoteSql(
      database.uuid,
      join(directory, `${environment}-request.json`),
      { retryOverloadedReads: !facts.verification.bound },
    );
    await checkImportIdentity(sql, identity.importSha256);
    await prepareBucket(environment, provenance);
    for (const key of await writeArchives(
      controlStoreFromEnvironment(target.bucket),
      bundle,
      lease,
    ))
      console.info(
        JSON.stringify({ operation: "data.remote.archive", environment, key }),
      );
    lease.assertHeld();
    const seeded = await seedDatabase(
      sql,
      join(bundle, databaseFile),
      manifest,
      facts.verification,
    );
    lease.assertHeld();
    await recordDatabaseVerification(
      control,
      environment,
      identity,
      facts,
      seeded,
      provenance,
    );
    await writeFile(
      join(directory, `${environment}.json`),
      `${JSON.stringify({ environment, snapshot: manifest.snapshot, manifestSha256, ...identity, database: database.uuid, databaseName, bucket: target.bucket, contacts: manifest.contacts, verification: seeded.verification, result: "verified" }, null, jsonIndentation)}\n`,
    );
    if (environment === "production") {
      const binding = v.parse(ProductionDatasetSchema, {
        manifestSha256,
        snapshot: manifest.snapshot,
        databaseSha256: manifest.databaseSha256,
        databaseId: database.uuid,
      });
      await writeFile(
        join(directory, "production-dataset.json"),
        `${JSON.stringify(binding, null, jsonIndentation)}\n`,
      );
    }
  } finally {
    await lease.release();
  }
}

async function main(args: readonly string[]): Promise<void> {
  const command = parseRemoteDataArguments(args);
  if (command.kind === "prepare") {
    await prepare(command.environment, command.bundle);
    return;
  }
  const store = controlStoreFromEnvironment();
  if (command.kind === "fetch") {
    await fetchDataset(store, command.manifestSha256, command.directory);
    await checkedProductionDataBundle(command.directory);
    console.info(
      JSON.stringify({
        operation: "data.remote.fetch",
        manifestSha256: command.manifestSha256,
        result: "verified",
      }),
    );
    return;
  }
  await checkedProductionDataBundle(command.bundle);
  console.info(
    JSON.stringify({
      operation: "data.remote.store",
      manifestSha256: await storeDataset(store, command.bundle),
      result: "stored",
    }),
  );
}

if (process.argv[1] === resolve("infrastructure/cloudflare/src/remote-data.ts"))
  await main(process.argv.slice(commandArgumentOffset));
