---
date: 2026-10-30
---

# Validated public directory collection

## Status

Proposed.

## Context

Public contact coverage needs repeatable additions from heterogeneous government publications.
School names and short local telephone spellings cannot establish identity without additional evidence.
An upstream catalog timestamp does not establish the date of its underlying records.

## Decision

Collect explicitly licensed source bytes through the bounded content-addressed artifact adapter.
Keep discovery separate from the reviewed collection manifest.
Reconcile schools with active MEXT codes and require a unique compatible identity.
Use explicit voice columns and published area codes without geographic inference.
Exclude and report conflicting candidate telephone sets.
Prepare a separate canonical native publication and preserve the input database and existing contact IDs.
Normalize address representation across the website, API, JSONL, CSV, and vCard exports.
Derive remote database names from the exact database digest and retain the complete digest as the import ownership check.

## Consequences

Source hashes, licensing evidence, row outcomes, stable identities, and replayable inputs remain inspectable.
Missing or ambiguous records remain gaps instead of invented telephone contacts.
The collector depends on publisher availability, declared reuse metadata, parser semantics, and MEXT registry accuracy.
The proved policy predicates do not establish those external facts.
The [data contract](../data-sources.md) and [verification contract](../verification.md) define the current coverage and checked alternatives.
Unrestricted scraping, telephone-only deduplication, and overwriting the active database would weaken these boundaries.
