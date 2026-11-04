import { createHash } from "node:crypto";
import * as v from "valibot";
import {
  databaseResourceName,
  type Environment,
} from "../src/core/environment.ts";
import { DigestSchema } from "../src/core/models.ts";
import { foldedCharacters } from "../src/core/search-text.ts";
import { databaseSchema } from "./database-schema.ts";
import { seedColumns } from "./remote-statements.ts";

/** Raise this when the import derives a column or the full-text terms differently while the schema, the seeded columns, and the fold table stay the same. */
const derivationRevision = 1;

/** Everything besides the dataset's database bytes that decides what an import writes to D1. */
export interface ImportTransformation {
  readonly derivationRevision: number;
  readonly schema: string;
  readonly columns: Readonly<Record<string, readonly string[]>>;
  readonly folds: readonly (readonly [string, string])[];
}

/** This checkout's D1 schema, the columns its import seeds, and every fold of the comparison form that `folded_name` and the full-text terms hold. */
export const importTransformation: ImportTransformation = {
  derivationRevision,
  schema: databaseSchema,
  columns: seedColumns,
  folds: Array.from(foldedCharacters),
};

/** A dataset's database digest, the digest of the transformation that imports it, and the import identity that the two determine. */
export interface ImportIdentity {
  readonly databaseSha256: string;
  readonly transformationSha256: string;
  readonly importSha256: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Digests the transformation's JSON, whose fixed shape spells different transformations differently. */
function transformationDigest(transformation: ImportTransformation): string {
  return sha256(
    JSON.stringify([
      transformation.derivationRevision,
      transformation.schema,
      transformation.columns,
      transformation.folds,
    ]),
  );
}

/** Derives the identity that names a dataset's D1 database, fills its import table, and keys its verification evidence. */
export function importIdentity(
  databaseSha256: string,
  transformation: ImportTransformation = importTransformation,
): ImportIdentity {
  const database = v.parse(DigestSchema, databaseSha256);
  const transformationSha256 = transformationDigest(transformation);
  return {
    databaseSha256: database,
    transformationSha256,
    importSha256: sha256(`${database}:${transformationSha256}`),
  };
}

/** Names the D1 database that holds a dataset as this checkout imports it. */
export function importedDatabaseName(
  environment: Environment,
  databaseSha256?: string,
): string {
  return environment === "development"
    ? databaseResourceName(environment)
    : databaseResourceName(
        environment,
        importIdentity(databaseSha256 ?? "").importSha256,
      );
}
