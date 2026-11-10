---
date: 2026-11-04
---

# Verify each D1 database once before a Worker binds it

## Status

Proposed.
[Import identity](identify-each-d1-database-by-its-dataset-and-import-transformation.md) amends verification keys.
The [deployment proposal](deploy-tested-worker-builds-through-github-actions.md) replaces publication coordination.

## Context

Full-table verification competes with live D1 queries.
Repeated verification of an already bound database contributed to observed release-time overload.

## Decision

Verify imports fully while unbound and keep a passing record for the exact database ID and import identity.
Read actual current and candidate Worker bindings before deciding whether preparation may scan or write.
Matching verification permits bounded ownership, checkpoint, and primary-key reads.
Reject an unverified live database before scans or writes.
Retained historical publication records can establish earlier verification, but can't establish current bindings.

## Alternatives

Throttled scans still compete with live traffic.
Accepting every complete database admits imports that never passed verification.

## Consequences

Unchanged verified databases avoid repeated scans.
The reuse check leaves later provider corruption undetected.
Recreated databases require fresh verification.
Reconsider verification frequency if provider integrity or write ownership changes.

## Confirmation

Tests reject missing history, stale bindings, and mismatched verification.
Proof controls reject scanning bound databases.
The [deployment runbook](../deployment.md) defines current preparation and publication operations.
