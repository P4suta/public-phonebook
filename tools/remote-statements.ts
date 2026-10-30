import * as v from "valibot";
import { boundedLimit } from "../src/core/search-policy.ts";

export const seedColumns = {
  contacts: [
    "rowid",
    "id",
    "name",
    "normalized_name",
    "prefecture",
    "municipality",
    "category",
    "source_id",
    "payload",
  ],
  phones: ["number", "contact_rowid"],
  sources: ["id", "payload"],
  contact_search: ["rowid", "terms"],
  metadata: ["key", "payload"],
} as const;
export type SeedTable = keyof typeof seedColumns;
export type SqlValue = string | number | null;
export interface SqlStatement {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}
export interface SqlPort {
  execute(
    statements: readonly SqlStatement[],
  ): Promise<readonly Record<string, unknown>[]>;
}
const RowSchema = v.array(
  v.union([v.string(), v.pipe(v.number(), v.finite()), v.null()]),
);

export function* insertStatements(
  table: SeedTable,
  rows: Iterable<readonly SqlValue[]>,
): Generator<SqlStatement> {
  let params: SqlValue[] = [];
  let groups: string[] = [];
  function statement(): SqlStatement {
    if (!boundedLimit(params.length))
      throw new Error("Invalid D1 parameter count");
    return {
      sql: `INSERT INTO ${table} (${seedColumns[table].join(",")}) VALUES ${groups.join(",")}`,
      params,
    };
  }
  for (const row of rows) {
    v.parse(RowSchema, row);
    if (row.length !== seedColumns[table].length)
      throw new Error("Invalid import row width");
    if (!boundedLimit(params.length + row.length)) {
      yield statement();
      params = [];
      groups = [];
    }
    params.push(...row);
    groups.push(`(${row.map(() => "?").join(",")})`);
  }
  if (params.length > 0) yield statement();
}
