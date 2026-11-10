---
date: 2026-10-30
---

# Validated public directory collection

## Status

Proposed.
[Import identity](identify-each-d1-database-by-its-dataset-and-import-transformation.md) partly supersedes database naming.

## Context

Government publications differ in licensing, identifiers, telephone formats, and freshness.
Names and short telephone spellings can't establish facility identity on their own.

## Decision

Collect explicitly licensed bytes through bounded content-addressed adapters.
Separate discovery from reviewed collection inputs under `data/sources`.
Require unique compatible school identifiers from Japan's education ministry.
Use published voice columns and area codes without geographic inference.
Report conflicting candidates instead of inventing repairs.
Preserve stable contact identities and source attribution.
Parse publisher files without credentials.
A later job validates prepared outputs before write-once storage.
Make cached replay reproduce artifact bytes and report order.

## Alternatives

Unrestricted scraping weakens provenance.
Telephone-only deduplication can merge distinct facilities.
Overwriting active data exposes incomplete preparation.

## Consequences

Missing or ambiguous records remain inspectable gaps.
Publisher availability, licensing metadata, parser behavior, and registry accuracy remain external assumptions.
Reconsider adapters when publishers change formats or reuse terms.

## Confirmation

The [data contract](../data-sources.md) defines coverage and evidence.
Collection tests exercise reconciliation, conflicting candidates, bounded inputs, and deterministic replay.
Full-data checks gate stored publications.
