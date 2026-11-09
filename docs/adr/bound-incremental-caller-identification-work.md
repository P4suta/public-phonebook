---
date: 2026-11-06
status: proposed
---

# Bound incremental caller identification work

## Context

[Issue #357](https://github.com/P4suta/public-phonebook/issues/357) records termination at the extension's 12 MB limit.
Comparing 600,000 unchanged entries retained about 136 MiB on the host without CallKit operations.

## Decision

Drain pools around file reads and CallKit operations, following [Apple's memory guidance](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/MemoryMgmt/Articles/mmAutoreleasePools.html).
Preflight changes without effects.
A pure, overflow-safe decision permits at most 1,000 individual changes.
Otherwise, clear entries once and stream the target, [only during incremental requests](https://developer.apple.com/documentation/callkit/cxcalldirectoryextensioncontext/removeallidentificationentries()).

## Alternatives

Pools alone leave CallKit work unbounded.
Always replacing reloads everything for one changed verification number.

## Consequences

Preflight adds one bounded-memory scan.
The operation limit doesn't prove framework memory usage.

## Confirmation

Require isolated footprint regressions, seeded caller-load tests, failure-before-mutation tests, and source-bound decision proofs.
Confirm small and large reloads on the iPhone without memory termination.
Reconsider the threshold if memory or latency exceeds device budgets.
