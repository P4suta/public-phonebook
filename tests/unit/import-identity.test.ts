import { isDeepStrictEqual } from "node:util";
import {
  type ImportTransformation,
  importedDatabaseName,
  importIdentity,
  importTransformation,
} from "@public-phonebook/cloudflare/import-identity";
import { databaseResourceName } from "@public-phonebook/directory/environment";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

const digest = fc.stringMatching(/^[a-f0-9]{64}$/u);
const character = fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 });
const text = fc.string({ unit: "grapheme" });
const transformation: fc.Arbitrary<ImportTransformation> = fc.record({
  derivationRevision: fc.nat(),
  schema: text,
  columns: fc
    .uniqueArray(
      fc.tuple(
        fc.stringMatching(/^[a-z_]{1,12}$/u),
        fc.array(text, { maxLength: 4 }),
      ),
      { selector: ([table]) => table, maxLength: 4 },
    )
    .map((entries) => Object.fromEntries(entries)),
  folds: fc.array(fc.tuple(character, character), { maxLength: 8 }),
});
const transformations = fc.oneof(
  transformation,
  fc.constant(importTransformation),
);

function name(databaseSha256: string, input: ImportTransformation): string {
  return databaseResourceName(
    "production",
    importIdentity(databaseSha256, input).importSha256,
  );
}

type Change = (
  databaseSha256: string,
  input: ImportTransformation,
) => readonly [string, ImportTransformation];

/** Each change rewrites exactly one input: the digest, the revision, the schema, the seeded columns, or the fold table. */
const changes: fc.Arbitrary<Change> = fc.oneof(
  fc.tuple(fc.nat({ max: 63 }), fc.integer({ min: 1, max: 15 })).map(
    ([at, step]): Change =>
      (databaseSha256, input) => [
        `${databaseSha256.slice(0, at)}${((Number.parseInt(databaseSha256.charAt(at), 16) + step) % 16).toString(16)}${databaseSha256.slice(at + 1)}`,
        input,
      ],
  ),
  fc.integer({ min: 1, max: 1000 }).map(
    (step): Change =>
      (databaseSha256, input) => [
        databaseSha256,
        { ...input, derivationRevision: input.derivationRevision + step },
      ],
  ),
  fc.tuple(fc.nat(), fc.string({ unit: "grapheme", minLength: 1 })).map(
    ([at, inserted]): Change =>
      (databaseSha256, input) => {
        const position = at % (input.schema.length + 1);
        return [
          databaseSha256,
          {
            ...input,
            schema: `${input.schema.slice(0, position)}${inserted}${input.schema.slice(position)}`,
          },
        ];
      },
  ),
  fc.tuple(fc.nat(), text).map(
    ([at, column]): Change =>
      (databaseSha256, input) => {
        const tables = Object.keys(input.columns);
        const table = tables[at % Math.max(tables.length, 1)] ?? "added";
        return [
          databaseSha256,
          {
            ...input,
            columns: {
              ...input.columns,
              [table]: [...(input.columns[table] ?? []), column],
            },
          },
        ];
      },
  ),
  fc.tuple(fc.nat(), character, character).map(
    ([at, from, to]): Change =>
      (databaseSha256, input) => {
        const folds = [...input.folds];
        const position = at % (folds.length + 1);
        const current = folds[position];
        if (current && current[1] !== to) folds[position] = [current[0], to];
        else if (current) folds.splice(position, 1);
        else folds.push([from, to]);
        return [databaseSha256, { ...input, folds }];
      },
  ),
);

describe("import identity", () => {
  it("gives equal inputs the same name", () => {
    fc.assert(
      fc.property(digest, transformations, (databaseSha256, input) => {
        expect(name(databaseSha256, structuredClone(input))).toBe(
          name(databaseSha256, input),
        );
        expect(importIdentity(databaseSha256, input)).toEqual(
          importIdentity(databaseSha256, structuredClone(input)),
        );
      }),
      { seed: 20261104, numRuns: 200 },
    );
  });

  it("gives another name when the digest or any transformation input changes", () => {
    fc.assert(
      fc.property(
        digest,
        transformations,
        changes,
        (databaseSha256, input, change) => {
          const [changedDigest, changedInput] = change(databaseSha256, input);
          fc.pre(
            changedDigest !== databaseSha256 ||
              !isDeepStrictEqual(changedInput, input),
          );
          expect(name(changedDigest, changedInput)).not.toBe(
            name(databaseSha256, input),
          );
        },
      ),
      { seed: 20261105, numRuns: 1000 },
    );
  });

  it("never names a database the way the digest alone did", () => {
    fc.assert(
      fc.property(digest, transformations, (databaseSha256, input) => {
        expect(name(databaseSha256, input)).not.toBe(
          databaseResourceName("production", databaseSha256),
        );
      }),
      { seed: 20261106, numRuns: 200 },
    );
    const served =
      "438c96a4b1166520d800867cf5a864621fd2542e4da2dc93a19037b96eab67b4";
    expect(importedDatabaseName("production", served)).not.toBe(
      "dial-production-directory-438c96a4b1166520d800867cf5a86462",
    );
  });

  it("derives the identity from fixed inputs as the pinned derivation", () => {
    expect(
      importIdentity("a".repeat(64), {
        derivationRevision: 1,
        schema: "CREATE TABLE contacts (name TEXT NOT NULL);",
        columns: { contacts: ["name"] },
        folds: [["ア", "あ"]],
      }),
    ).toEqual({
      databaseSha256: "a".repeat(64),
      transformationSha256:
        "549fe371955a459a6614c896b03216414878ab83c9ffc26dfbb3ae7d2613d6df",
      importSha256:
        "8cd55d3020922ac4a5b3b8528ab808aeb91db52352cc9d5140d597fe26e9330e",
    });
  });

  it("names this checkout's production database by the import identity and keeps the fixed development name", () => {
    const databaseSha256 = "b".repeat(64);
    expect(importedDatabaseName("production", databaseSha256)).toBe(
      databaseResourceName(
        "production",
        importIdentity(databaseSha256).importSha256,
      ),
    );
    expect(importedDatabaseName("development")).toBe(
      "dial-development-directory",
    );
    expect(importedDatabaseName("development", databaseSha256)).toBe(
      "dial-development-directory",
    );
    expect(() => importedDatabaseName("production")).toThrow();
    expect(() => importedDatabaseName("production", "../unbound")).toThrow();
  });
});
