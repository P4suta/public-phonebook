---
date: 2026-11-05
---

# Activate complete Android directory generations

## Status

Accepted as part of the Android implementation plan.

## Context

Android search and caller identification read one offline national directory, while an update can stop at any instruction.
The archive and delta contracts already serve iOS and the website.

## Decision

Each update builds and validates a new SQLite generation, and one `AtomicFile` pointer names the current and preceding generations.
Readers use an immutable complete generation, and the repository serializes imports.
The [Android design notes](../android.md#data-and-update-design) give the validation, search, transfer, and call-screening rules.

## Alternatives

An in-place database update couples readers to recovery from a partial transaction.
A network lookup during call screening makes availability and latency conditions for identifying a call.

## Confirmation

Lean proofs, host differential tests, injected failures, and device tests cover publication, ranking, and caller responses, as the [refinement record](../../verification/android/refinement.md) lists.

## Consequences

Updates need disk space for two generations, a decoded archive, and indexes.
