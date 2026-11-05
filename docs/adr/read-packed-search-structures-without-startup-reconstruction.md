---
date: 2026-11-05
---

# Read packed search structures without startup reconstruction

## Status

Accepted.
The implementation brief authorizes changing artifact layout and loading while preserving the frozen scorer.
This partly supersedes [the companion format](publish-snapshot-bound-forgiving-search-artifacts.md) and [the scorer construction](rank-device-search-with-place-preferences-and-gated-readings.md).
The ranking policy and shared fixture remain unchanged.

## Context

The phase 2 website constructs national strings, maps, posting arrays, and a reading trie at admission.
Measured worker admission takes about 7.8 seconds and adds 2.1 GB of Chromium process memory and more than 6 GB of WebKit process memory.
The iPhone port constructs equivalent structures from compressed saved files on each launch.
The saved-generation app measurement takes about 24 seconds and peaks at more than one gigabyte.
The earlier lexical experiment shows that precomputed posting lists and byte views can avoid much of the construction cost.
Its narrower scorer doesn't establish the integrated scorer's performance.

## Decision

Publish `public-phonebook-search-ranking/2` under the existing content-addressed `search-ranking.br` routes.
Keep the name index's format and row order unchanged.
Continue reading retained ranking format 1 artifacts.
The prepared manifest declares the actual compressed and decoded digests and byte lengths of the selected artifact.

The packed header contains snapshot identity, contact count, analyzer identity, variants, aliases, unknown weight, section lengths, and the canonical format 1 source fingerprint.
The fingerprint preserves the unchanged shared fixture's binding.
The packed file has a separate digest.
The data gate regenerates both the canonical fingerprint and every packed byte from the database and pinned analyzer.

The payload uses little-endian fixed-width tables and UTF-8 byte blobs.
Each row stores its normalized ranking name, compact reading, scalar length, and distinct-character count.
The builder computes lexical norms, weights, and distinct literal and reading trigram counts once.
Sorted dictionaries contain string identifiers, posting offsets, and counts.
Lexical and reading postings keep canonical base-128 deltas.
Short-query postings store the first 100 rows in the existing length and row order because the scorer consumes only that prefix.
The reading exact dictionary keeps every row.
Identical literal and folded exact indexes share one representation.
Whole-name and whole-reading exact indexes store sorted row permutations.
Original and written exact comparisons read candidate keys through the name index.
They preserve distinct written forms without storing another national copy of their text.
The builder normalizes, aggregates, and sorts reading token choices within the existing eight-path limit.

Readers keep the packed bytes and decode only posting lists and strings needed by a query.
The lexical and phonetic readers stream each queried posting directly into candidate accumulation without allocating a decoded posting array.
The measured process budget includes actual runtime overhead.
An 8,192-entry ring caches decoded strings of at most 256 UTF-16 code units.
The website views name-index lines through offset tables and decodes result rows on demand.
The stream reader allocates the declared decoded length once rather than keeping chunks and another complete concatenation.
It verifies SHA-256 incrementally with the pinned [noble-hashes 2.4.0 API](https://github.com/paulmillr/noble-hashes/tree/2.4.0#implementations).
The worker uses the browser HTTP decoder with the Fetch standard's [no-store request cache mode](https://fetch.spec.whatwg.org/#concept-request-cache-mode) to reduce decoded cache storage.
Searching offline within the admitted page remains available, while a fresh page needs another download.
The server's content-addressed route keeps its immutable response cache policy for other clients.
Lexical and reading candidate accumulation reuse fixed-width scratch arrays and clear every touched row after each query.
Reading overlap checks whether candidate text contains query grams and uses the precomputed distinct counts instead of constructing every candidate's gram array.
Malformed surrogate grams use the original scalar-gram calculation.
The existing SHA-256, snapshot, transport-header, size, and generation checks remain mandatory.
The ECMAScript [DataView contract](https://tc39.es/ecma262/multipage/structured-data.html#sec-dataview-objects) supplies explicit byte offsets and little-endian reads without requiring aligned typed-array storage.

The binary decoder checks section extents, string offsets, row references, exact permutations, posting counts, canonical deltas, row bounds, weights, aliases, and variants.
The complete regeneration gate checks dictionary order, normalization, and correspondence with the snapshot.
Browser admission trusts the verified publisher's declared artifact identity for those semantic properties.
The source fingerprint alone supplies no equivalent semantic check.

Record a 1,500 ms post-arrival admission budget and a 400,000,000-byte peak added process-memory budget for Chromium, desktop WebKit, and mobile WebKit.
Compare complete-ranking p95 with the phase 2 measurements for the same browser profile.
Missing memory attribution or a missing ranking campaign can't produce a passing budget verdict.
The existing release measurement report carries the budgets and their individual verdicts.
Loopback, viewport emulation, and sampled resident memory remain distinct from physical-phone and network measurements.

## Consequences

Build-time work and artifact bytes replace startup object construction.
The format keeps a 64 MiB compressed limit, a 256 MiB decoded limit, and at most 2,000,000 contacts.
The packed row fields reject lengths exceeding 65,535 scalars and norms outside unsigned 32-bit storage.
The builder uses Brotli quality 6 for the companion so that the larger precomputed representation remains practical to generate.
The existing name-index compression remains unchanged.

Reconstructing the maps on devices preserves transfer size but repeats the measured startup and memory cost.
Dropping retrieval evidence would change rankings and violates the contract.
Eagerly expanding compressed postings replaces a compact immutable representation with national arrays before a query needs them.
The packed reader instead trades binary searches, candidate decoding, and a larger transfer for lower startup memory.
Measured query latency determines whether that trade meets the existing p95 budget.

Source-translated proofs cover section-bound arithmetic, binary-search midpoint progress, short-posting count bounds, and scratch-sum bounds alongside the existing scoring arithmetic.
The scratch proof assumes the admitted limits of 256 distinct lexical grams, six distinct reading grams, positive weights, and unique rows within each posting.
They don't prove Unicode normalization, dictionary ordering, the complete byte traversal, target-label truth, or runtime memory consumption.
Small corruption and equivalence fixtures, complete regeneration, the unchanged national contract, and national quality thresholds cover those runtime and empirical boundaries.
Reconsider the checked alternatives if a maintained verifier can cover the actual string and byte-view implementation.
