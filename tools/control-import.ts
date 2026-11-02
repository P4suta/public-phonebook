import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import * as v from "valibot";
import { DigestSchema } from "../src/core/models.ts";
import {
  type ControlStore,
  controlKeys,
  controlStoreFromEnvironment,
  type FileBody,
  type RemoteEnvironment,
  readObject,
  sha256Hex,
  writeOnce,
} from "./control-store.ts";
import type { ReleaseJournal } from "./release-lifecycle.ts";
import {
  convertLegacyJournal,
  datasetFiles,
  encodeRecord,
  journalRecord,
  LegacyJournalSchema,
  legacyBundleName,
} from "./release-store.ts";
import { fileDigest } from "./snapshot.ts";

const commandArgumentOffset = 2;
const maximumArguments = 2;
const environmentNames: readonly RemoteEnvironment[] = ["production"];
const journalName = /^(production)-(journal|[0-9a-f-]{36})\.json$/u;
const retiredJournalName = /^staging-(journal|[0-9a-f-]{36})\.json$/u;
const databaseFile = "directory.sqlite";
const receiptSources = [
  { source: "test-receipt.json", scope: "imported/test-receipt" },
  { source: "proof-receipt.json", scope: "imported/proof-receipt" },
  {
    source: "remote-data/production.json",
    scope: "imported/remote-data-production",
  },
] as const;

const DatasetFileSchema = v.object({
  file: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9._-]*$/u)),
  sha256: DigestSchema,
  bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const RetainedManifestSchema = v.object({
  databaseSha256: DigestSchema,
  files: v.array(DatasetFileSchema),
  searchIndex: v.optional(DatasetFileSchema),
});

export interface PlannedObject {
  readonly key: string;
  readonly source: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly body: Uint8Array | FileBody;
}
export interface PlannedJournal {
  readonly environment: RemoteEnvironment;
  readonly sequence: number;
  readonly releaseId: string;
  readonly phase: ReleaseJournal["phase"];
  readonly source: string;
}
export interface ImportPlan {
  readonly objects: readonly PlannedObject[];
  readonly heads: readonly PlannedObject[];
  readonly journals: readonly PlannedJournal[];
  readonly skipped: readonly {
    readonly source: string;
    readonly reason: string;
  }[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

function memoryObject(
  key: string,
  source: string,
  body: Uint8Array,
): PlannedObject {
  return { key, source, bytes: body.byteLength, sha256: sha256Hex(body), body };
}

interface LegacyEntry {
  readonly environment: RemoteEnvironment;
  readonly name: string;
  readonly record: unknown;
  readonly modifiedMs: number;
}

export function orderLegacyHistory(
  environment: RemoteEnvironment,
  entries: readonly {
    readonly name: string;
    readonly modifiedMs: number;
    readonly journal: ReleaseJournal;
  }[],
  head: ReleaseJournal | null,
): readonly { readonly name: string; readonly journal: ReleaseJournal }[] {
  const ordered = [...entries].sort(
    (first, second) =>
      first.modifiedMs - second.modifiedMs ||
      (first.name < second.name ? -1 : first.name === second.name ? 0 : 1),
  );
  ordered.forEach((entry, index) => {
    const previous = entry.journal.previous;
    if (
      previous &&
      !ordered
        .slice(0, index)
        .some(
          (earlier) =>
            earlier.journal.candidate.releaseId === previous.releaseId &&
            earlier.journal.candidate.versionId === previous.versionId,
        )
    )
      throw new Error(
        `The ${environment} history has no earlier record for the predecessor of ${entry.name}`,
      );
  });
  const last = ordered.at(-1);
  if (head && JSON.stringify(last?.journal) !== JSON.stringify(head))
    throw new Error(
      `The ${environment} journal head isn't the latest release record`,
    );
  if (!head && last)
    throw new Error(`The ${environment} release records have no journal head`);
  return ordered;
}

export async function planControlImport(
  directory: string,
): Promise<ImportPlan> {
  const root = resolve(directory);
  const releases = join(root, "releases");
  const skipped: { source: string; reason: string }[] = [];
  const legacy: LegacyEntry[] = [];
  for (const name of (await readdir(releases)).sort()) {
    const path = join(releases, name);
    if (!(await stat(path)).isFile()) continue;
    const match = journalName.exec(name);
    if (!match) {
      skipped.push({
        source: relative(root, path),
        reason: retiredJournalName.test(name)
          ? "a journal of the retired staging environment"
          : "not a format 1 publication journal",
      });
      continue;
    }
    legacy.push({
      environment: v.parse(v.picklist(environmentNames), match[1]),
      name,
      record: JSON.parse(await readFile(path, "utf8")),
      modifiedMs: (await stat(path)).mtimeMs,
    });
  }
  const bundleDigests = new Map<string, string>();
  for (const entry of legacy) {
    const record = v.parse(LegacyJournalSchema, entry.record);
    for (const target of [record.candidate, record.previous]) {
      if (!target) continue;
      const name = legacyBundleName(target.bundle);
      const manifest = join(releases, "bundles", name, "manifest.ready.json");
      if (!bundleDigests.has(name) && (await exists(manifest)))
        bundleDigests.set(name, await fileDigest(manifest));
    }
  }
  const objects: PlannedObject[] = [];
  const heads: PlannedObject[] = [];
  const journals: PlannedJournal[] = [];
  const manifests = new Set<string>();
  for (const environment of environmentNames) {
    const entries = legacy.filter((entry) => entry.environment === environment);
    const convert = (entry: LegacyEntry): ReleaseJournal =>
      convertLegacyJournal({
        environment,
        fileName: entry.name,
        record: entry.record,
        manifestDigest: (name) => bundleDigests.get(name),
      });
    const headEntry = entries.find(
      (entry) => entry.name === `${environment}-journal.json`,
    );
    const ordered = orderLegacyHistory(
      environment,
      entries
        .filter((entry) => entry !== headEntry)
        .map((entry) => ({
          name: entry.name,
          modifiedMs: entry.modifiedMs,
          journal: convert(entry),
        })),
      headEntry ? convert(headEntry) : null,
    );
    ordered.forEach((entry, index) => {
      const sequence = index + 1;
      const bytes = encodeRecord(
        journalRecord(environment, sequence, entry.journal, { kind: "local" }),
      );
      const source = `releases/${entry.name}`;
      objects.push(
        memoryObject(
          controlKeys.journalHistory(environment, sequence),
          source,
          bytes,
        ),
      );
      journals.push({
        environment,
        sequence,
        releaseId: entry.journal.candidate.releaseId,
        phase: entry.journal.phase,
        source,
      });
      for (const target of [entry.journal.candidate, entry.journal.previous])
        if (target) manifests.add(target.manifestSha256);
      if (sequence === ordered.length)
        heads.push(
          memoryObject(
            controlKeys.journalHead(environment),
            `releases/${environment}-journal.json`,
            bytes,
          ),
        );
    });
  }
  for (const manifest of [...manifests].sort())
    for (const file of datasetFiles) {
      const path = join(releases, "bundles", manifest, file);
      objects.push(
        memoryObject(
          controlKeys.dataset(manifest, file),
          relative(root, path),
          new Uint8Array(await readFile(path)),
        ),
      );
    }
  const located = new Set<string>();
  for (const entry of (await readdir(root, { withFileTypes: true })).sort(
    (first, second) => (first.name < second.name ? -1 : 1),
  )) {
    if (!entry.isDirectory()) continue;
    const dataset = join(root, entry.name);
    const manifestPath = join(dataset, "manifest.ready.json");
    if (!(await exists(manifestPath))) continue;
    const digest = await fileDigest(manifestPath);
    if (!manifests.has(digest) || located.has(digest)) continue;
    located.add(digest);
    const manifest = v.parse(
      RetainedManifestSchema,
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    const files = [
      ...manifest.files,
      ...(manifest.searchIndex ? [manifest.searchIndex] : []),
    ];
    const database = join(dataset, databaseFile);
    files.push({
      file: databaseFile,
      sha256: manifest.databaseSha256,
      bytes: (await stat(database)).size,
    });
    for (const file of files) {
      const path = join(dataset, file.file);
      const size = (await stat(path)).size;
      const sha256 = await fileDigest(path);
      if (size !== file.bytes || sha256 !== file.sha256)
        throw new Error(
          `A retained dataset file differs from its manifest: ${relative(root, path)}`,
        );
      objects.push({
        key: controlKeys.blob(sha256),
        source: relative(root, path),
        bytes: size,
        sha256,
        body: { path, bytes: size, sha256 },
      });
    }
  }
  for (const manifest of manifests)
    if (!located.has(manifest))
      skipped.push({
        source: `releases/bundles/${manifest}`,
        reason: "no retained dataset files match this manifest",
      });
  for (const receipt of receiptSources) {
    const path = join(root, receipt.source);
    if (!(await exists(path))) continue;
    const body = new Uint8Array(await readFile(path));
    v.parse(
      v.record(v.string(), v.unknown()),
      JSON.parse(new TextDecoder().decode(body)),
    );
    objects.push(
      memoryObject(
        controlKeys.evidence(receipt.scope, sha256Hex(body)),
        receipt.source,
        body,
      ),
    );
  }
  const unique = new Map<string, PlannedObject>();
  for (const object of objects) {
    const known = unique.get(object.key);
    if (known && known.sha256 !== object.sha256)
      throw new Error(`Two sources map to ${object.key} with different bytes`);
    if (!known) unique.set(object.key, object);
  }
  return { objects: [...unique.values()], heads, journals, skipped };
}

export async function applyControlImport(
  store: ControlStore,
  plan: ImportPlan,
): Promise<{ readonly created: number; readonly unchanged: number }> {
  for (const head of plan.heads) {
    const current = await readObject(store, head.key);
    if (current && sha256Hex(current.body) !== head.sha256)
      throw new Error(
        `The control store already holds a different journal: ${head.key}`,
      );
  }
  let created = 0;
  let unchanged = 0;
  for (const object of [...plan.objects, ...plan.heads]) {
    if (!(object.body instanceof Uint8Array)) {
      if (await store.head(object.key)) unchanged += 1;
      else {
        await store.write(object.key, object.body, { kind: "create" });
        created += 1;
      }
      continue;
    }
    if ((await writeOnce(store, object.key, object.body)) === "created")
      created += 1;
    else unchanged += 1;
  }
  return { created, unchanged };
}

async function main(args: readonly string[]): Promise<void> {
  const [directory, flag] = args;
  if (
    !directory ||
    args.length > maximumArguments ||
    (flag !== undefined && flag !== "--plan")
  )
    throw new Error("Usage: control-import DIRECTORY [--plan]");
  const plan = await planControlImport(directory);
  for (const journal of plan.journals)
    console.info(
      JSON.stringify({ operation: "control.import.journal", ...journal }),
    );
  for (const object of [...plan.objects, ...plan.heads])
    console.info(
      JSON.stringify({
        operation: "control.import.object",
        key: object.key,
        source: object.source,
        bytes: object.bytes,
        sha256: object.sha256,
      }),
    );
  for (const entry of plan.skipped)
    console.info(
      JSON.stringify({ operation: "control.import.skipped", ...entry }),
    );
  const summary = {
    objects: plan.objects.length + plan.heads.length,
    bytes: [...plan.objects, ...plan.heads].reduce(
      (sum, object) => sum + object.bytes,
      0,
    ),
    journals: Object.fromEntries(
      environmentNames.map((environment) => [
        environment,
        plan.journals.filter((journal) => journal.environment === environment)
          .length,
      ]),
    ),
    skipped: plan.skipped.length,
  };
  if (flag === "--plan") {
    console.info(
      JSON.stringify({
        operation: "control.import.plan",
        ...summary,
        mutation: false,
      }),
    );
    return;
  }
  const result = await applyControlImport(controlStoreFromEnvironment(), plan);
  console.info(
    JSON.stringify({
      operation: "control.import",
      ...summary,
      ...result,
      mutation: true,
    }),
  );
}

if (process.argv[1] === resolve("tools/control-import.ts"))
  await main(process.argv.slice(commandArgumentOffset));
