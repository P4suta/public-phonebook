import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import type { DatasetManifest } from "../src/core/models.ts";
import {
  type ImportDecision,
  importDecision,
} from "../src/core/publication-policy.ts";
import { nameTokens } from "../src/core/search.ts";
import { databaseSchema } from "./database-schema.ts";
import {
  insertStatements,
  type SeedTable,
  type SqlPort,
  type SqlStatement,
  type SqlValue,
  seedColumns,
} from "./remote-statements.ts";

const maximumBatchStatements = 256;
const maximumRequestBytes = 2_000_000;
const midpointDivisor = 2;

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
    "SELECT rowid,normalized_name FROM contacts ORDER BY rowid LIMIT -1 OFFSET ?",
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
        nameTokens(v.parse(v.string(), row.normalized_name)).join(" "),
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

export async function seedDatabase(
  port: SqlPort,
  path: string,
  manifest: DatasetManifest,
): Promise<void> {
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    const decision = await checkImportIdentity(port, manifest.databaseSha256);
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
          params: [stage, manifest.databaseSha256],
        })),
      ]);
    }
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
      progress.some((item) => item.snapshot !== manifest.databaseSha256)
    )
      throw new Error("Incomplete import progress");
    for (const stage of stages) {
      const previous = progress.find((item) => item.stage === stage);
      if (!previous) throw new Error("Missing import stage");
      const expectedTable = stage === "contact_search" ? "contacts" : stage;
      const expected = v.parse(
        CountSchema,
        source.prepare(`SELECT count(*) AS count FROM ${expectedTable}`).get()
          ?.count,
      );
      if (previous.completed > expected)
        throw new Error("Import checkpoint exceeds its source");
      if (
        (await copyStage(
          port,
          source,
          stage,
          previous.completed,
          manifest.databaseSha256,
        )) !== expected
      )
        throw new Error(`Incomplete remote stage: ${stage}`);
    }
    const counts = await port.execute([
      {
        sql: "SELECT (SELECT count(*) FROM contacts) AS contacts,(SELECT count(*) FROM phones) AS relations,(SELECT count(DISTINCT number) FROM phones) AS phones,(SELECT count(*) FROM sources) AS sources,(SELECT count(*) FROM contact_search) AS indexed,(SELECT count(DISTINCT category) FROM contacts) AS categories,(SELECT count(DISTINCT prefecture) FROM contacts) AS prefectures",
        params: [],
      },
    ]);
    const expectedCounts = source
      .prepare(
        "SELECT (SELECT count(*) FROM contacts) AS contacts,(SELECT count(*) FROM phones) AS relations,(SELECT count(DISTINCT number) FROM phones) AS phones,(SELECT count(*) FROM sources) AS sources,(SELECT count(*) FROM contact_search) AS indexed,(SELECT count(DISTINCT category) FROM contacts) AS categories,(SELECT count(DISTINCT prefecture) FROM contacts) AS prefectures",
      )
      .get();
    for (const [key, value] of Object.entries(expectedCounts ?? {}))
      if (counts[0]?.[key] !== value)
        throw new Error(`Remote count mismatch: ${key}`);
    const foreignKeys = await port.execute([
      { sql: "PRAGMA foreign_key_check", params: [] },
    ]);
    if (foreignKeys.length !== 0)
      throw new Error("Remote foreign key violation");
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
    console.info(
      JSON.stringify({
        operation: "data.remote.verified",
        ...counts[0],
        snapshot: manifest.snapshot,
      }),
    );
  } finally {
    source.close();
  }
}
