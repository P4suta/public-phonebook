import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { manifestObjectKey } from "../src/core/dataset-storage.ts";
import { databaseResourceName, environments } from "../src/core/environment.ts";
import { DigestSchema } from "../src/core/models.ts";
import { checkDataBundle } from "./check-data.ts";
import { cloudflare, remoteSql } from "./cloudflare.ts";
import { acquireLease, type PublicationLease } from "./control-lease.ts";
import {
  type ControlStore,
  controlKeys,
  controlStoreFromEnvironment,
  isConflict,
  type RemoteEnvironment,
  readObject,
  sha256Hex,
} from "./control-store.ts";
import {
  RemoteEnvironmentSchema,
  type RunProvenance,
  runProvenance,
  storeVerificationDataset,
} from "./release-store.ts";
import { checkImportIdentity, seedDatabase } from "./seed-database.ts";
import { fileDigest } from "./snapshot.ts";

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
  "Usage: remote-data ENVIRONMENT BUNDLE | remote-data --fetch MANIFEST_SHA256 DIRECTORY | remote-data --store BUNDLE";

export function parseRemoteDataArguments(
  args: readonly string[],
): RemoteDataCommand {
  const [first, second, third] = args;
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
  deltas: v.optional(v.array(RetainedFileSchema), []),
});
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
    RetainedManifestSchema,
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
    RetainedManifestSchema,
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
    RetainedManifestSchema,
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
    const manifest = await checkDataBundle(bundle);
    const manifestSha256 = await fileDigest(
      join(bundle, "manifest.ready.json"),
    );
    const target = environments[environment];
    const databaseName = databaseResourceName(
      environment,
      manifest.databaseSha256,
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
    const sql = remoteSql(
      database.uuid,
      join(directory, `${environment}-request.json`),
    );
    await checkImportIdentity(sql, manifest.databaseSha256);
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
    await seedDatabase(sql, join(bundle, databaseFile), manifest);
    await writeFile(
      join(directory, `${environment}.json`),
      `${JSON.stringify({ environment, snapshot: manifest.snapshot, manifestSha256, databaseSha256: manifest.databaseSha256, database: database.uuid, databaseName, bucket: target.bucket, contacts: manifest.contacts, result: "verified" }, null, jsonIndentation)}\n`,
    );
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
    await checkDataBundle(command.directory);
    console.info(
      JSON.stringify({
        operation: "data.remote.fetch",
        manifestSha256: command.manifestSha256,
        result: "verified",
      }),
    );
    return;
  }
  await checkDataBundle(command.bundle);
  console.info(
    JSON.stringify({
      operation: "data.remote.store",
      manifestSha256: await storeDataset(store, command.bundle),
      result: "stored",
    }),
  );
}

if (process.argv[1] === resolve("tools/remote-data.ts"))
  await main(process.argv.slice(commandArgumentOffset));
