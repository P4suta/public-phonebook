import { DatabaseSync } from "node:sqlite";
import {
  insertStatements,
  type SeedTable,
  type SqlPort,
  type SqlStatement,
  type SqlValue,
  seedColumns,
} from "@public-phonebook/cloudflare/remote-statements";
import { databaseSchema } from "@public-phonebook/data/database-schema";
import type { DatasetManifest } from "@public-phonebook/directory/models";
import {
  type DatabaseVerification,
  databaseVerification,
  type ImportDecision,
  importDecision,
} from "@public-phonebook/directory/publication-policy";
import { nameTokens } from "@public-phonebook/directory/search";
import { searchForm } from "@public-phonebook/directory/search-text";
import * as v from "valibot";

const maximumBatchStatements = 256;
const maximumRequestBytes = 2_000_000;
const midpointDivisor = 2;
const foldedColumn = seedColumns.contacts.indexOf("folded_name");

const stages = [
  "contacts",
  "phones",
  "sources",
  "contact_search",
  "metadata",
] as const;
const queries: Record<SeedTable, string> = {
  contacts:
    "SELECT rowid,id,name,normalized_name,prefecture,municipality,category,source_id,payload FROM contacts ORDER BY rowid LIMIT -1 OFFSET ?",
  phones:
    "SELECT number,contact_rowid FROM phones ORDER BY number,contact_rowid LIMIT -1 OFFSET ?",
  sources: "SELECT id,payload FROM sources ORDER BY id LIMIT -1 OFFSET ?",
  contact_search:
    "SELECT rowid,name FROM contacts ORDER BY rowid LIMIT -1 OFFSET ?",
  metadata: "SELECT key,payload FROM metadata ORDER BY key LIMIT -1 OFFSET ?",
};
const ValueSchema = v.union([
  v.string(),
  v.pipe(v.number(), v.finite()),
  v.null(),
]);
const CountSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const ProgressSchema = v.array(
  v.object({
    stage: v.picklist(stages),
    completed: CountSchema,
    snapshot: v.string(),
  }),
);

function* sourceRows(
  source: DatabaseSync,
  stage: SeedTable,
  completed: number,
): Generator<readonly SqlValue[]> {
  for (const row of source.prepare(queries[stage]).iterate(completed)) {
    if (stage === "contact_search") {
      yield [
        v.parse(CountSchema, row.rowid),
        nameTokens(searchForm(v.parse(v.string(), row.name))).join(" "),
      ];
    } else if (stage === "contacts") {
      // The comparison form derives from the display name, so a bundle built before the column existed still seeds it.
      const values = v.parse(v.array(ValueSchema), Object.values(row));
      yield [
        ...values.slice(0, foldedColumn),
        searchForm(v.parse(v.string(), row.name)),
        ...values.slice(foldedColumn),
      ];
    } else yield v.parse(v.array(ValueSchema), Object.values(row));
  }
}

export async function copyStage(
  port: SqlPort,
  source: DatabaseSync,
  stage: SeedTable,
  completed: number,
  snapshot: string,
  options: { readonly batchStatements: number } = {
    batchStatements: maximumBatchStatements,
  },
): Promise<number> {
  v.parse(
    v.pipe(CountSchema, v.minValue(1), v.maxValue(maximumBatchStatements)),
    options.batchStatements,
  );
  v.parse(CountSchema, completed);
  let batch: SqlStatement[] = [];
  let bytes = 0;
  let position = completed;
  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    await port.execute([
      ...batch,
      {
        sql: "UPDATE __dial_import SET completed=? WHERE stage=? AND snapshot=?",
        params: [position, stage, snapshot],
      },
    ]);
    console.info(
      JSON.stringify({
        operation: "data.remote.progress",
        stage,
        completed: position,
      }),
    );
    batch = [];
    bytes = 0;
  }
  const width = seedColumns[stage].length;
  for (const statement of insertStatements(
    stage,
    sourceRows(source, stage, completed),
  )) {
    const size = new TextEncoder().encode(JSON.stringify(statement)).byteLength;
    if (size > maximumRequestBytes)
      throw new Error("An import statement exceeds the request budget");
    if (
      bytes + size > maximumRequestBytes ||
      batch.length >= options.batchStatements
    )
      await flush();
    batch.push(statement);
    bytes += size;
    position += statement.params.length / width;
  }
  await flush();
  return position;
}

export async function checkImportIdentity(
  port: SqlPort,
  requested: string,
): Promise<ImportDecision> {
  const names = await port.execute([
    {
      sql: "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      params: [],
    },
  ]);
  let current = "";
  if (names.length > 0) {
    if (!names.some((row) => row.name === "__dial_import"))
      throw new Error("Refusing to replace an unowned database");
    const values = await port.execute([
      { sql: "SELECT DISTINCT snapshot FROM __dial_import", params: [] },
    ]);
    if (values.length !== 1) throw new Error("Invalid remote import identity");
    current = v.parse(v.string(), values[0]?.snapshot);
  }
  const decision = importDecision(current, requested);
  if (decision === "conflict")
    throw new Error("Refusing to replace a different publication");
  return decision;
}

async function importProgress(
  port: SqlPort,
  importSha256: string,
): Promise<v.InferOutput<typeof ProgressSchema>> {
  const progress = v.parse(
    ProgressSchema,
    await port.execute([
      {
        sql: "SELECT stage,snapshot,completed FROM __dial_import",
        params: [],
      },
    ]),
  );
  if (
    progress.length !== stages.length ||
    new Set(progress.map((item) => item.stage)).size !== stages.length ||
    progress.some((item) => item.snapshot !== importSha256)
  )
    throw new Error("Incomplete import progress");
  return progress;
}

function sourceRowCount(source: DatabaseSync, stage: SeedTable): number {
  const table = stage === "contact_search" ? "contacts" : stage;
  return v.parse(
    CountSchema,
    source.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count,
  );
}

/** Compares the catalog and fixed records by primary key, which reads a handful of rows even from a database that serves traffic. */
async function compareRecords(
  port: SqlPort,
  source: DatabaseSync,
  manifest: DatasetManifest,
): Promise<void> {
  for (const offset of [
    0,
    Math.floor(manifest.contacts / midpointDivisor),
    manifest.contacts - 1,
  ]) {
    const expected = source
      .prepare(
        "SELECT id,payload FROM contacts ORDER BY rowid LIMIT 1 OFFSET ?",
      )
      .get(offset);
    if (!expected) throw new Error("Missing source comparison record");
    const actual = await port.execute([
      {
        sql: "SELECT id,payload FROM contacts WHERE id=?",
        params: [v.parse(v.string(), expected.id)],
      },
    ]);
    if (actual[0]?.payload !== expected.payload)
      throw new Error("Remote payload comparison failed");
  }
  const catalog = await port.execute([
    { sql: "SELECT payload FROM metadata WHERE key='catalog'", params: [] },
  ]);
  if (
    catalog[0]?.payload !==
    source.prepare("SELECT payload FROM metadata WHERE key='catalog'").get()
      ?.payload
  )
    throw new Error("Remote catalog mismatch");
}

const countsQuery =
  "SELECT (SELECT count(*) FROM contacts) AS contacts,(SELECT count(*) FROM phones) AS relations,(SELECT count(DISTINCT number) FROM phones) AS phones,(SELECT count(*) FROM sources) AS sources,(SELECT count(*) FROM contact_search) AS indexed,(SELECT count(DISTINCT category) FROM contacts) AS categories,(SELECT count(DISTINCT prefecture) FROM contacts) AS prefectures";
export const RemoteCountsSchema = v.strictObject({
  contacts: CountSchema,
  relations: CountSchema,
  phones: CountSchema,
  sources: CountSchema,
  indexed: CountSchema,
  categories: CountSchema,
  prefectures: CountSchema,
});
export type RemoteCounts = v.InferOutput<typeof RemoteCountsSchema>;

/** What the preparation knows before it reads the database: its import identity, the evidence stored for that identity and resource, and the journal's bindings. */
export interface VerificationFacts {
  readonly importSha256: string;
  readonly resource: string;
  readonly evidence: {
    readonly importSha256: string;
    readonly database: string;
  } | null;
  readonly bound: boolean;
  readonly publicationVerified: boolean;
}

export type SeedResult =
  | { readonly verification: "verify"; readonly counts: RemoteCounts }
  | { readonly verification: "accept-evidence" | "accept-publication" };

const refusals = {
  "foreign-evidence":
    "The database's verification evidence names another database",
  "incomplete-database":
    "Refusing to import into a database that verification evidence or a Worker binding names",
  "unverified-binding":
    "Refusing to scan a database that a Worker version may bind, because no evidence of its full verification exists",
} as const satisfies Partial<Record<DatabaseVerification, string>>;

/**
 * Imports and fully verifies a database that no Worker version binds, or accepts the evidence of its earlier full verification after cheap identity checks.
 * The decision runs before any write or full-table read.
 */
export async function seedDatabase(
  port: SqlPort,
  path: string,
  manifest: DatasetManifest,
  facts: VerificationFacts,
): Promise<SeedResult> {
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    const decision = await checkImportIdentity(port, facts.importSha256);
    let progress =
      decision === "start"
        ? null
        : await importProgress(port, facts.importSha256);
    const complete =
      progress?.every(
        (item) => item.completed === sourceRowCount(source, item.stage),
      ) ?? false;
    const verification = databaseVerification(
      facts.evidence !== null,
      facts.evidence?.importSha256 ?? "",
      facts.importSha256,
      facts.evidence?.database ?? "",
      facts.resource,
      complete,
      facts.bound,
      facts.publicationVerified,
    );
    if (
      verification === "accept-evidence" ||
      verification === "accept-publication"
    ) {
      await compareRecords(port, source, manifest);
      console.info(
        JSON.stringify({
          operation: "data.remote.verified",
          verification,
          snapshot: manifest.snapshot,
        }),
      );
      return { verification };
    }
    if (verification !== "verify") throw new Error(refusals[verification]);
    if (decision === "start") {
      await port.execute([
        ...databaseSchema
          .split(";")
          .map((sql) => sql.trim())
          .filter(Boolean)
          .map((sql) => ({ sql, params: [] })),
        {
          sql: "CREATE TABLE __dial_import(stage TEXT PRIMARY KEY,snapshot TEXT NOT NULL,completed INTEGER NOT NULL)",
          params: [],
        },
        ...stages.map((stage) => ({
          sql: "INSERT INTO __dial_import VALUES (?,?,0)",
          params: [stage, facts.importSha256],
        })),
      ]);
      progress = await importProgress(port, facts.importSha256);
    }
    for (const stage of stages) {
      const previous = progress?.find((item) => item.stage === stage);
      if (!previous) throw new Error("Missing import stage");
      const expected = sourceRowCount(source, stage);
      if (previous.completed > expected)
        throw new Error("Import checkpoint exceeds its source");
      if (
        (await copyStage(
          port,
          source,
          stage,
          previous.completed,
          facts.importSha256,
        )) !== expected
      )
        throw new Error(`Incomplete remote stage: ${stage}`);
    }
    const counts = await port.execute([{ sql: countsQuery, params: [] }]);
    const expectedCounts = source.prepare(countsQuery).get();
    for (const [key, value] of Object.entries(expectedCounts ?? {}))
      if (counts[0]?.[key] !== value)
        throw new Error(`Remote count mismatch: ${key}`);
    const foreignKeys = await port.execute([
      { sql: "PRAGMA foreign_key_check", params: [] },
    ]);
    if (foreignKeys.length !== 0)
      throw new Error("Remote foreign key violation");
    await compareRecords(port, source, manifest);
    const verified = v.parse(RemoteCountsSchema, counts[0]);
    console.info(
      JSON.stringify({
        operation: "data.remote.verified",
        verification,
        ...verified,
        snapshot: manifest.snapshot,
      }),
    );
    return { verification, counts: verified };
  } finally {
    source.close();
  }
}
