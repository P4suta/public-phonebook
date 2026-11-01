---
date: 2026-10-30
---

# Activate iOS snapshots before cleanup

## Status

Proposed.
Implemented locally for review.

## Context

An update must preserve the active dataset and its retained predecessor until a replacement becomes visible.
Deleting the predecessor before replacing the manifest made an activation failure damage retained reads and prevent later updates.
An error reported after a successful manifest replacement could also cause the importer's `abort` path to delete the newly active database.
Cleanup and extension notification failures must remain distinguishable from failure to publish data.

## Decision

Model publication as staging, prepared, uncertain, active, and discarded states.
Enter the uncertain state before invoking the fallible atomic manifest replacement.
If replacement reports an error, reread the manifest before deciding whether the new generation is active or known inactive.
Keep the database when the outcome remains unknown.
Only staging, prepared, and discarded states permit deletion by `abort`.
Clear the import draft after confirmed activation, then remove obsolete generations while retaining the current and previous generation.
Retry orphan cleanup under the cross-process writer lease on later updates.
Observe post-commit cleanup and extension notifications as distinct operations.

Use a shared finite contract to generate the Lean publication model and exhaustively compare every production Swift transition and discard capability.
Check arbitrary finite traces in Lean, inspect theorem axioms, and replay compiled proof modules with the fresh kernel checker.
Bind the receive-budget arithmetic theorem to the exact guarded Swift expression and its 64-bit integer interpretation.
The project gate rejects an invalid contract, a false deletion theorem, unsupported proof escapes, and stale verification receipts.

## Consequences

An uncertain outcome can keep an extra database until a later recovery.
The app reports uncertainty instead of claiming that the previous dataset necessarily remains active.
The optional manifest origin preserves the existing format and prevents automatic updates from changing the saved dataset's service origin.
Legacy manifests without an origin require one manual update before automatic refresh.

The proofs cover the source-refined state machine and guarded arithmetic.
They trust the Swift compiler's enum, integer, and short-circuit semantics.
They don't prove Foundation atomic-write durability, SQLite, process crashes, power loss, or Apple extension behavior.
Deterministic filesystem fault injection, real SQLite tests, actual URLSession tests, sanitizers, and native UI checks cover those adapters within their stated execution scope.
The [assurance record](../ios-assurance.md) maps the production boundaries to these checks and their remaining limits.
