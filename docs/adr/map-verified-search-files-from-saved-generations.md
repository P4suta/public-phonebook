---
date: 2026-11-05
---

# Map verified search files from saved generations

## Status

Accepted.
The implementation brief authorizes changing storage and loading while preserving the frozen ranking contract.
The decision extends the [packed artifact layout](read-packed-search-structures-without-startup-reconstruction.md).

## Context

The saved iPhone generation keeps compressed search files and rebuilds national strings, posting maps, and a reading trie on launch.
The phase 2 app takes about 24 seconds to search readiness and uses about one gigabyte of memory.
Saving the directory already runs through a storage actor and protects the active generation until activation succeeds.

## Decision

Decode and verify search artifacts once during import.
Save decoded immutable files with the generation, their published identities, line offsets, and the checked row mapping.
Use a distinct saved-search format for the decoded cache and keep the compressed saved-search reader for earlier generations.
Upgrade an earlier generation through a replacement generation so failure leaves active data readable.

On later launches, stream file digests through bounded buffers before requesting Foundation's [alwaysMapped reading option](https://developer.apple.com/documentation/foundation/nsdata/readingoptions/alwaysmapped).
Apple describes the option as a hint to map the file when possible.
Read fixed-width tables and query candidates directly from immutable data views.
Never rebuild a national reading trie or posting dictionary on the packed path.
Keep the original Swift contract test and its format 1 resources unchanged.
Stage only the selected packed companion and the unchanged name index into the national app bundle.

Invalid identities, sizes, section bounds, row mappings, or snapshots fail admission.
Cancellation and failed installation preserve the active generation.
The import remains on the storage actor and reports progress through the existing interface.

Record saved-generation startup, peak searching memory, query p95, and app launch measurements with explicit budgets.
The targets are one second to saved search readiness and 250,000,000 bytes while searching.
Compare query p95 with the phase 2 national Simulator baseline of 19.133292 ms.
Missing measurements remain incomplete evidence.

## Consequences

Decoded storage consumes more disk space than compressed storage.
Mapping avoids a second national object graph and makes later launches independent of decompression and scorer reconstruction.
File hashes preserve integrity, while the checked import establishes semantic correspondence with the directory.
Source-bound arithmetic proofs cover section bounds and binary-search progress.
Query-local fixed-width arrays accumulate candidate weights without national dictionaries or shared mutable scratch storage.
The reader copies only the precomputed unsigned 32-bit norm table for frequent candidate reads.
The lexical and phonetic posting caches evict the earliest entries first.
Each cache has a 4 MiB accounting limit and holds at most 256 entries.
Cache misses decode outside the mutex, and queries keep immutable arrays after releasing the mutex.
The cache accounts for row bytes, key bytes, and 128 bytes per entry, while measurements include actual runtime overhead.
Each hash chunk and search call scopes Foundation temporary objects to an [autorelease pool](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/MemoryMgmt/Articles/mmAutoreleasePools.html).
The scopes bound temporary-object lifetimes during command-line loops and background work.
The reading lane resolves each query token once per input position and keeps candidate literals through sorting.
Names whose graphemes span more than one scalar keep the original scalar-gram overlap calculation.
The scratch-sum proof assumes at most 256 distinct query grams, positive weights of at most 100,000, and unique rows within each posting.
Corruption tests, complete national ranking comparisons, integration tests, and measurements cover file I/O, Unicode, actor scheduling, and runtime memory outside the arithmetic model.
