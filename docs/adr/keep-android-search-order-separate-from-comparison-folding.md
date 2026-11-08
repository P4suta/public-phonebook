---
date: 2026-11-08
---

# Keep Android search order separate from comparison folding

## Status

Proposed.

## Context

The website and iPhone sort normalized names.
Android sorts matching names after kana folding.
Archive row positions order categories before names and can't replace a name key.

## Decision

Sort by rank, `NFKC`-normalized lowercase name in binary UTF-8 order, and archive row position.
Import a separate sort key.
Migrate saved databases and their schema version in one exclusive transaction before querying.
Interrupted migrations roll back and retry without downloading.

Android's [transactions](https://developer.android.com/reference/android/database/sqlite/SQLiteDatabase#beginTransaction()) and [database versions](https://developer.android.com/reference/android/database/sqlite/SQLiteDatabase#setVersion(int)) supply the storage boundary.
The store's write lock excludes readers during migration.
Directory records and [generation publication](activate-complete-android-directory-generations.md) stay unchanged.

## Alternatives

Folded names preserve the mismatch.
Reimporting the archive repeats unrelated indexing.
Sorting decoded contacts repeats normalization on every query.

## Confirmation

Require native ordering, migration recovery, and caller lookup tests through `just android-check`.

## Consequences

Storage grows by one name key per contact.
Native tests cover kana order, migration rollback and retry, and caller lookup.
Unicode and filesystem durability remain runtime boundaries.
