---
date: 2026-11-04
---

# Identify each D1 database by its dataset and import transformation

## Status

Proposed.
Amends [database verification](verify-each-database-once-before-a-worker-binds-it.md) and [directory collection](validated-public-directory-collection.md).

## Context

A dataset digest identifies source bytes but doesn't identify the schema, seeded columns, or comparison folds used during import.
Reusing a database after those transformations change can serve incompatible rows.

## Decision

Hash the source database digest with a transformation digest covering the derivation revision, schema, seeded columns, and comparison folds.
Name imports and verification records by that identity.
Store the full identity in the database ownership row.
Raise the derivation revision when transformation behavior changes beyond those declared values.
Determine Worker bindings by D1 ID.
The [deployment proposal](deploy-tested-worker-builds-through-github-actions.md) commits the selected database ID.

## Alternatives

Source-file hashes would repeat imports after formatting.
The dataset digest alone misses derived schema and search terms.

## Consequences

A transformation change creates and verifies a fresh database while existing bindings keep serving.
The derivation revision depends on review.
Reconsider output hashing if transformation declarations become unreliable.

## Confirmation

Import tests reject mismatched ownership and stale verification.
Source-bound proofs check binding decisions under the [verification contract](../verification.md).
