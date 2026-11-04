---
date: 2026-10-30
---

# Validated public directory collection

## Status

Proposed.
[Identify each D1 database by its dataset and import transformation](identify-each-d1-database-by-its-dataset-and-import-transformation.md) partly supersedes its rule for remote database names.

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

Write the collection report in a fixed order with the digest and size of the contacts, sources, and source artifact list.
The report digest then identifies the complete output, and an offline replay of the same cache must reproduce every file byte for byte.
Collect in GitHub Actions only when the owner dispatches the workflow on `main`, and keep `just data-collect` for local runs.
Parse publisher files in a job without credentials.
Give the control-store credentials only to a later job, which reads validated JSON and the base database that `sources/base-dataset.json` pins by digest and size.
Write the source bytes, the collection, and the prepared publication to `dial-control` under write-once keys only after the full-data checks pass.

## Consequences

Source hashes, licensing evidence, row outcomes, stable identities, and replayable inputs remain inspectable.
Missing or ambiguous records remain gaps instead of invented telephone contacts.
The collector depends on publisher availability, declared reuse metadata, parser semantics, and MEXT registry accuracy.
The proved policy predicates do not establish those external facts.
Every stored collection can be replayed from its own records, and storing it again changes nothing.
A compromised parser can't reach the control-store credentials, but crafted publisher data that passes the full-data checks still reaches the stored publication.
The owner's release approval remains the gate for that content.
Publishers may refuse hosted runners outside Japan, which the first dispatch measures, and local collection stays available.
The [data contract](../data-sources.md) and [verification contract](../verification.md) define the current coverage and checked alternatives.
Unrestricted scraping, telephone-only deduplication, and overwriting the active database would weaken these boundaries.
