import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { manifestObjectKey } from "../src/core/dataset-storage.ts";
import { databaseResourceName, environments } from "../src/core/environment.ts";
import { checkDataBundle } from "./check-data.ts";
import { cloudflare, remoteSql } from "./cloudflare.ts";
import { releaseLock } from "./release-store.ts";
import { checkImportIdentity, seedDatabase } from "./seed-database.ts";
import { fileDigest } from "./snapshot.ts";

const remoteDataArgumentCount = 2;
const maximumR2UploadBytes = 300_000_000;
const jsonIndentation = 2;
const commandArgumentOffset = 2;

async function main(args: readonly string[]): Promise<void> {
  const environment = v.parse(v.picklist(["staging", "production"]), args[0]);
  const bundle = args[1];
  if (!bundle || args.length !== remoteDataArgumentCount)
    throw new Error("Usage: remote-data ENVIRONMENT BUNDLE");
  v.parse(
    v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/u)),
    process.env.CLOUDFLARE_ACCOUNT_ID,
  );
  const directory = resolve(".local/remote-data");
  await mkdir(directory, { recursive: true });
  const unlock = await releaseLock(environment);
  try {
    const manifest = await checkDataBundle(resolve(bundle));
    const manifestSha256 = await fileDigest(
      resolve(bundle, "manifest.ready.json"),
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
    for (const file of manifest.files) {
      if (file.bytes > maximumR2UploadBytes)
        throw new Error("An archive exceeds the supported R2 upload size");
      await cloudflare([
        "r2",
        "objects",
        "put",
        `${manifest.snapshot}/${file.sha256}/${file.file}`,
        "--bucket-name",
        target.bucket,
        "--file",
        resolve(bundle, file.file),
        "--content-type",
        "application/gzip",
        "--content-length",
        String(file.bytes),
      ]);
      console.info(
        JSON.stringify({
          operation: "data.remote.archive",
          environment,
          file: file.file,
          bytes: file.bytes,
        }),
      );
    }
    await cloudflare([
      "r2",
      "objects",
      "put",
      manifestObjectKey(manifest.snapshot, manifestSha256),
      "--bucket-name",
      target.bucket,
      "--file",
      resolve(bundle, "manifest.ready.json"),
      "--content-type",
      "application/json",
    ]);
    await seedDatabase(sql, resolve(bundle, "directory.sqlite"), manifest);
    await writeFile(
      join(directory, `${environment}.json`),
      `${JSON.stringify({ environment, snapshot: manifest.snapshot, manifestSha256, databaseSha256: manifest.databaseSha256, database: database.uuid, databaseName, bucket: target.bucket, contacts: manifest.contacts, result: "verified" }, null, jsonIndentation)}\n`,
    );
  } finally {
    await unlock();
  }
}

await main(process.argv.slice(commandArgumentOffset));
