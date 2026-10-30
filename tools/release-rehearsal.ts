import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import { CatalogSchema, ContactSchema } from "../src/core/models.ts";
import { checkDataBundle } from "./check-data.ts";
import { requireCommand } from "./process.ts";
import { loadRelease } from "./release-store.ts";
import { fileDigest, prepareSnapshot } from "./snapshot.ts";

const argumentOffset = 2;
const requiredArguments = 2;
const selection =
  "SELECT id,payload FROM contacts WHERE rowid IN (SELECT min(rowid) FROM contacts GROUP BY prefecture UNION SELECT min(rowid) FROM contacts GROUP BY category UNION SELECT rowid FROM contacts WHERE name LIKE '高知大学%' OR name LIKE '国立国会図書館%') ORDER BY id";

async function prepare(
  sourceBundle: string,
  directory: string,
): Promise<string> {
  const sourceManifest = await checkDataBundle(sourceBundle);
  directory = join(
    directory,
    await fileDigest(join(sourceBundle, "manifest.ready.json")),
  );
  await mkdir(directory, { recursive: true });
  const output = join(directory, "directory-a");
  try {
    await checkDataBundle(output);
    return output;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  await rm(output, { recursive: true, force: true });
  await rm(join(directory, "source-a.sqlite"), { force: true });
  const source = new DatabaseSync(join(sourceBundle, "directory.sqlite"), {
    readOnly: true,
  });
  const subsetPath = join(directory, "source-a.sqlite");
  const subset = new DatabaseSync(subsetPath);
  try {
    subset.exec(
      "CREATE TABLE contacts(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE sources(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE metadata(key TEXT PRIMARY KEY,payload TEXT NOT NULL)",
    );
    const rows = source.prepare(selection).all();
    const categories = new Map<string, number>();
    const prefectures = new Map<string, number>();
    const phones = new Set<string>();
    const hash = createHash("sha256");
    const insert = subset.prepare("INSERT INTO contacts VALUES (?,?)");
    for (const row of rows) {
      const payload = v.parse(v.string(), row.payload);
      const contact = v.parse(ContactSchema, JSON.parse(payload));
      insert.run(contact.id, payload);
      hash.update(`${payload}\n`);
      categories.set(
        contact.category,
        (categories.get(contact.category) ?? 0) + 1,
      );
      prefectures.set(
        contact.prefectureCode,
        (prefectures.get(contact.prefectureCode) ?? 0) + 1,
      );
      for (const phone of contact.phones) phones.add(phone.e164);
    }
    const original = v.parse(
      CatalogSchema,
      JSON.parse(await readFile(join(sourceBundle, "catalog.json"), "utf8")),
    );
    const catalog = {
      ...original,
      snapshot: hash.digest("hex"),
      contacts: rows.length,
      phones: phones.size,
      categories: original.categories
        .map((category) => ({
          ...category,
          contacts: categories.get(category.id) ?? 0,
        }))
        .filter((category) => category.contacts > 0),
      prefectures: original.prefectures.map((prefecture) => ({
        ...prefecture,
        contacts: prefectures.get(prefecture.code) ?? 0,
      })),
    };
    if (
      catalog.categories.length !== original.categories.length ||
      catalog.prefectures.some((prefecture) => prefecture.contacts === 0)
    )
      throw new Error(
        "The rehearsal subset must retain every populated category and prefecture",
      );
    for (const row of source
      .prepare("SELECT id,payload FROM sources ORDER BY id")
      .iterate())
      subset
        .prepare("INSERT INTO sources VALUES (?,?)")
        .run(v.parse(v.string(), row.id), v.parse(v.string(), row.payload));
    subset
      .prepare("INSERT INTO metadata VALUES ('catalog',?)")
      .run(JSON.stringify(catalog));
  } finally {
    subset.close();
    source.close();
  }
  await prepareSnapshot(subsetPath, output);
  const checked = await checkDataBundle(output);
  console.info(
    JSON.stringify({
      operation: "publication.rehearsal.prepare",
      sourceSnapshot: sourceManifest.snapshot,
      subsetSnapshot: checked.snapshot,
      contacts: checked.contacts,
      result: "verified",
    }),
  );
  return output;
}

async function stagingPublish(bundle: string, action?: string): Promise<void> {
  await requireCommand("doppler", [
    "run",
    "--project",
    "public-phonebook",
    "--config",
    "stg",
    "--no-fallback",
    "--",
    process.execPath,
    "tools/publish.ts",
    "staging",
    bundle,
    ...(action ? [action] : []),
  ]);
}
async function stagingData(bundle: string): Promise<void> {
  await requireCommand("doppler", [
    "run",
    "--project",
    "public-phonebook",
    "--config",
    "prd",
    "--only-secrets",
    "CLOUDFLARE_ACCOUNT_ID",
    "--no-fallback",
    "--",
    process.execPath,
    "tools/remote-data.ts",
    "staging",
    bundle,
  ]);
}
async function main(args: readonly string[]): Promise<void> {
  const [action, sourceBundle] = args;
  if (
    args.length !== requiredArguments ||
    !sourceBundle ||
    !["prepare", "run"].includes(action ?? "")
  )
    throw new Error("Usage: release-rehearsal prepare|run SOURCE_BUNDLE");
  const full = resolve(sourceBundle);
  const subset = await prepare(full, resolve(".local/release-rehearsal"));
  if (action === "prepare") return;
  const previous = await loadRelease("staging");
  await stagingData(subset);
  await stagingPublish(subset, previous ? undefined : "--bootstrap");
  await stagingData(full);
  await stagingPublish(full, "--rehearse-recovery");
  await stagingPublish(full);
}
if (process.argv[1] === resolve("tools/release-rehearsal.ts"))
  await main(process.argv.slice(argumentOffset));
