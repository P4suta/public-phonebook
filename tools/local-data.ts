import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Miniflare } from "miniflare";
import { checkDataBundle } from "./check-data.ts";

const developmentHost = "127.0.0.1";
const developmentPort = 8787;
const commandArgumentOffset = 2;

async function serverIsRunning(port: number): Promise<boolean> {
  return new Promise((resolveConnection, reject) => {
    const socket = createConnection({ host: developmentHost, port });
    socket.once("connect", () => {
      socket.destroy();
      resolveConnection(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolveConnection(false);
      else reject(error);
    });
  });
}

export async function seedLocalData(
  bundle: string,
  options: { readonly state: string; readonly port: number } = {
    state: ".local/state",
    port: developmentPort,
  },
): Promise<void> {
  if (await serverIsRunning(options.port))
    throw new Error("Stop the local server before seeding data");
  const directory = resolve(bundle);
  const manifest = await checkDataBundle(directory);
  const database = join(directory, "directory.sqlite");
  const state = resolve(options.state, "v3");
  await mkdir(state, { recursive: true });
  const identity = randomUUID();
  const runtime = new Miniflare({
    cf: false,
    resourcePersistencePath: state,
    telemetry: { enabled: false },
    enableDevRegistry: false,
    workers: [
      {
        config: {
          name: "dial-development",
          compatibilityDate: "2026-10-29",
          manifest: {
            mainModule: "seed.js",
            modules: {
              "seed.js": {
                type: "esm",
                contents:
                  "export default { fetch() { return new Response('local data'); } }",
              },
            },
          },
          env: {
            DB: {
              type: "d1",
              id: "DB-dial-development",
              name: "dial-development-directory",
            },
            DATASETS: { type: "r2", name: "dial-development-datasets" },
          },
        },
      },
    ],
  });
  try {
    const db = await runtime.getD1Database("DB");
    await db.exec(
      "CREATE TABLE IF NOT EXISTS __local_seed_identity (identity TEXT NOT NULL)",
    );
    await db
      .prepare("INSERT INTO __local_seed_identity VALUES (?)")
      .bind(identity)
      .run();
    const bucket = await runtime.getR2Bucket("DATASETS");
    for (const file of manifest.files) {
      await bucket.put(
        `${manifest.snapshot}/${file.sha256}/${file.file}`,
        await readFile(join(directory, file.file)),
      );
    }
    await bucket.put(
      `${manifest.snapshot}/manifest.json`,
      JSON.stringify(manifest),
    );
  } finally {
    await runtime.dispose();
  }
  const sqliteDirectory = join(state, "d1/miniflare-D1DatabaseObject");
  const candidates: string[] = [];
  for (const entry of await readdir(sqliteDirectory)) {
    if (!entry.endsWith(".sqlite") || entry === "metadata.sqlite") continue;
    const path = join(sqliteDirectory, entry);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const table = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='__local_seed_identity'",
        )
        .get();
      if (
        table &&
        db
          .prepare(
            "SELECT identity FROM __local_seed_identity WHERE identity=?",
          )
          .get(identity)
      )
        candidates.push(path);
    } finally {
      db.close();
    }
  }
  if (candidates.length !== 1 || !candidates[0])
    throw new Error("Could not identify the pinned local D1 namespace");
  const target = candidates[0];
  const temporary = `${target}.${identity}.prepared`;
  await copyFile(database, temporary, constants.COPYFILE_FICLONE);
  await rename(temporary, target);
  for (const suffix of ["-wal", "-shm"])
    await rm(`${target}${suffix}`, { force: true });
  console.info(
    JSON.stringify({
      operation: "data.local.seed",
      snapshot: manifest.snapshot,
      contacts: manifest.contacts,
      datasets: manifest.files.length,
    }),
  );
}

if (import.meta.main) {
  const [bundle, ...extra] = process.argv.slice(commandArgumentOffset);
  if (!bundle || extra.length)
    throw new Error("Usage: npm run data:local -- BUNDLE_DIRECTORY");
  await seedLocalData(bundle);
}
