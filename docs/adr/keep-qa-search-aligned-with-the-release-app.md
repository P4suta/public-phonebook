---
date: 2026-11-06
status: proposed
---

# Keep verification search aligned with the release app

## Context

The unreleased QA app should exercise release behavior while allowing one controlled caller number.
Its experimental ranking adds bundled companions, startup verification, and synchronization requests that the release app doesn't use.
[Issue #328](https://github.com/P4suta/public-phonebook/issues/328) concerns startup verification cost, and [Issue #358](https://github.com/P4suta/public-phonebook/issues/358) records update checks blocked by retry waiting.

## Decision

Remove the iOS ranking target, companion storage, startup admission, and companion downloads.
Use the existing literal search and directory synchronization in every configuration.
Preserve the experiment in Git history without migration support for experimental QA state.

## Alternatives

Caching verified companion identities reduces hashing but preserves a QA-only runtime and its synchronization dependencies.
Optional downloads preserve the same testing mismatch.

## Consequences

QA loses spelling-tolerant ranking and can recreate its local data.
The controlled caller-number tool remains available.
Normal directory import, updates, and caller identification remain required.

## Confirmation

Require package and bundle checks, literal-search and update tests, startup measurements, and the combined QA device build.
Reconsider ranking through a separate release proposal with measured resource budgets.
