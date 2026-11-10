---
date: 2026-11-04
---

# Start from a bundled directory archive and catch up through deltas

## Status

Proposed in #224.
Issue #228 requires inexpensive paths for every automatic transfer.

## Context

A first run must work offline, and data freshness must not require an App Store submission.

## Decision

Bundle a national archive selected by immutable manifest, snapshot, length, and hash.
Validate it before import.
Use a matching delta when available and fall back to the verified bundle after transfer failure.
Keep automatic transfers off expensive or constrained paths.
Check listings conditionally after 24 hours.
Prepare deltas for shipped snapshots and a bounded window of published snapshots.
Keep shipped bases through reviewed retirement.

## Alternatives

Apple-hosted assets require newer deployment targets and reviewed pack distribution.
A prebuilt store increases packaged storage.
Per-contact detail downloads reveal which facility a person opens.

## Consequences

Offline startup uses bundled data until an update succeeds.
Imports and delta reconstruction need temporary disk space.
A missing delta requires a complete archive.
Reconsider packaging when measured import time or app size exceeds product limits.

## Confirmation

The [Apple runbook](../ios.md) defines offline, transfer, import, and footprint checks.
[Dataset contracts](../api.md) define archive and delta validation.
