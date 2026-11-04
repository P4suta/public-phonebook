---
date: 2026-11-04
---

# Identify each D1 database by its dataset and import transformation

## Status

Proposed.
It partly supersedes [validated public directory collection](validated-public-directory-collection.md), which derived remote database names from the database digest alone.
It amends [verify each D1 database once before a Worker binds it](verify-each-database-once-before-a-worker-binds-it.md) with the key of the database evidence and the binding rule.
It amends the consequence of [match every search word in the name, region, or category](match-every-search-word-in-the-name-region-or-category.md) that a reused D1 database keeps the folded names of its import.

## Context

A production D1 database took its name from the first 32 hexadecimal characters of the dataset's database SHA-256, and `__dial_import` recorded the full digest.
Preparation reused a database of that name, and its verification evidence lived under that digest.
The import doesn't copy the dataset's SQLite file, though.
It runs the release tree's D1 schema and copies the columns that tree seeds.
It derives `folded_name` and the full-text terms from each display name through the tree's comparison fold.
[Match every search word in the name, region, or category](match-every-search-word-in-the-name-region-or-category.md) added the `folded_name` column, and the fold table changes whenever its variant sources change.
A database that an earlier tree imported keeps that tree's schema and folded names.
Reusing it by name serves rows that the Worker can't query, or folded names that miss newer folds.

The journal counted a target with the same dataset digest as a binding of the database.
Once a name covers more than the digest, that rule refuses the fresh database of a dataset that production already serves.

The data check requires each row of a bundle's SQLite to carry the `folded_name` of the current fold, so it refuses bundles prepared on an earlier fold.
It reads only the bundle, though, and covers neither the D1 schema, the seeded columns, nor the full-text terms.
On 2026-11-04 production served manifest `021f5435c7c8b2df143da1616ea65225284e61c512d428841887527eb4e0a8d6`, whose bundle predates `folded_name`, and the data check on that day's `main` refused that bundle.

## Decision

Name a D1 database, fill its `__dial_import`, and key its verification evidence by its import identity.
`tools/import-identity.ts` derives the identity as the SHA-256 of the database SHA-256 and the digest of the import transformation.
The transformation digest covers one JSON array of four inputs.
The four inputs are a declared derivation revision, the D1 schema, the seeded columns, and every fold of the comparison form.
`tools/database-schema.ts` holds the schema, and `tools/remote-statements.ts` holds the columns.
`src/core/search-text.ts` holds the folds.
The folds include the katakana, small kana, and dash folds besides the kanji variant pairs.
A change to how the import derives a column or the full-text terms raises the derivation revision.
A digest of values can't detect a change in that code.
`cloudflare.config.ts` derives the same name from `DIAL_DATABASE_SHA256` and its own checkout, so the release workflows keep passing the dataset digest.

Evidence moves to `evidence/databases/IMPORT/ID.json` in format 2, which records the database digest, the transformation digest, and the import identity.
Evidence under the earlier digest keys stays in the locked bucket, and preparation never reads it again.

A journal target binds a database only through the D1 ID that its Worker version holds, because a Worker version binds a D1 database by ID.
It vouches for a database without evidence only when it also names the same dataset and the release tools prepared it and staged it by digest.
`targetBinding` in `src/core/publication-policy.ts` states this rule, and Dafny proves it for all inputs.
Its proof control binds a database of the same dataset under another ID and must fail.
`databaseVerification` and `importDecision` compare the import identity as an opaque string, so their contracts keep their meaning.

## Consequences

The first release on this decision creates a new D1 database even for a dataset that production already serves.
It imports that database in full and verifies it in full before any version binds it.
The first release after any later change to the schema, the seeded columns, the fold table, or the derivation revision does the same.
The database that an earlier identity named keeps serving until promotion moves traffic away, and retiring it stays an owner decision under the retention rule.
A reused name now means the same dataset under the same transformation, and the full identity in `__dial_import` refuses a database that an earlier identity filled.

The derivation revision depends on review.
A change to `sourceRows` or `nameTokens` that forgets to raise it reuses a database whose derived terms differ.
The digest follows the order of the seeded tables and of the folds, so a reordering alone gives a new database, which costs an import but serves correct rows.
The identity relies on SHA-256 collision resistance and on JSON spelling different transformations differently.

Rejected alternatives:
- Hashing the import's source files would also rename databases after formatting and unrelated edits.
- Recording the identity in each journal target would need a new journal format and a reader for format 2 history, while binding by D1 ID needs neither.
- Digesting each dataset's derived rows would follow the outputs exactly, but the build job has no dataset to digest.
- Relying on the data check would leave the D1 schema and the full-text terms outside the identity.
