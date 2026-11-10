---
date: 2026-11-05
---

# Activate iOS search artifacts with directory generations

## Status

Accepted in #308.
[QA scope](keep-forgiving-search-in-qa-and-local-development.md) and [mapped generations](map-verified-search-files-from-saved-generations.md) partly supersede the distribution and storage details.

## Context

Ranking artifacts use name order while saved contacts use archive order.
An interrupted update must preserve a consistent searchable generation.

## Decision

Admit companion lengths, hashes, formats, counts, and snapshots before activation.
Map ranked rows to saved contacts through a complete permutation that preserves duplicate records.
Bind the mapping hash in the generation declaration.
Synchronize archive, search, and mapping files before atomically replacing the active manifest.
Keep the previous generation and remove inactive drafts through the existing publication state machine.
Keep search files outside the caller extension.

## Alternatives

A global mutable index could mix snapshots.
Device morphology would add an analyzer dictionary and change parity assumptions.

## Consequences

Generations need extra disk space, but failed imports preserve search.
Reconsider artifact separation if measured storage becomes unacceptable.

## Confirmation

Package tests cover migration, full and delta imports, duplicate mappings, rejection, retained reads, and cleanup.
The [Apple runbook](../ios.md) defines current measurement commands and limits.
