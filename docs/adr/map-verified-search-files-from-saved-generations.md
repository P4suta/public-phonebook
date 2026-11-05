---
date: 2026-11-05
---

# Map verified search files from saved generations

## Status

Accepted.
[QA and local forgiving search](keep-forgiving-search-in-qa-and-local-development.md) limits it to QA builds, and it extends the [packed layout](read-packed-search-structures-without-startup-reconstruction.md).

## Context

The phase 2 app rebuilt national search structures on launch, taking about 24 seconds and one gigabyte.

## Decision

Decode and verify search artifacts once during import, and save the decoded files, their identities, line offsets, and row mapping with the generation.
Later launches hash the files and read them through Foundation's [alwaysMapped option](https://developer.apple.com/documentation/foundation/nsdata/readingoptions/alwaysmapped) without rebuilding national structures.
Failed or cancelled imports keep the active generation.

## Alternatives

Rebuilding on launch keeps less storage but repeats the 24-second construction.

## Confirmation

`mise x -- just ios-search-measure` records saved readiness, searching memory, and query p95 against their budgets, as [the iOS guide](../ios.md) describes.

## Consequences

Decoded files use more storage, and later launches skip decompression and scorer construction.
