---
date: 2026-11-08
---

# Read browser search data from temporary files

## Status

Proposed.

## Context

The national index adds 305–401 MB of physical footprint in four browser profiles after the existing reductions.
Search buffers must fit within a few megabytes.
[Local search](search-in-the-browser-once-the-index-loads.md) must keep queries on the device after admission.

## Decision

Stream the verified index into origin-private temporary files.
Keep category and region codes, one rank byte per contact, and fixed read buffers within 8 MiB.
Scan folded UTF-8 names from files.
Read display data only for visible results.
Keep the existing wire format and ranking.

Use [synchronous access handles](https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle) inside the Worker.
Protect each temporary directory with a [Web Lock](https://www.w3.org/TR/web-locks/).
Remove inactive directories on startup and replaced directories on disposal.
Never write queries or diagnostics.
Storage failure uses the existing server fallback, including WebKit private contexts that reject origin-private storage.

## Alternatives

Retaining the full index avoids storage operations but misses the requested working set.
Server search avoids the index but sends queries and loses offline search.

## Consequences

Temporary public data consumes disk space.
Browser process overhead remains separate from search buffers.

## Confirmation

Require corruption, parity, interruption, cleanup, offline, and four-profile measurements.
Reconsider if disk scans miss the interaction budget.
