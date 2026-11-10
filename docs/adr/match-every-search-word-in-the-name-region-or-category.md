---
date: 2026-11-04
---

# Match every search word in the name, region, or category

## Status

Accepted.
[Place preferences and gated readings](rank-device-search-with-place-preferences-and-gated-readings.md) partly supersede device ranking.
[Server fallback](show-one-ranked-list-with-a-server-fallback.md) preserves server word matching.

## Context

A whole-query substring misses facilities when words name their city and category.
Web, server, and native comparisons must agree.

## Decision

Recognize complete telephone queries before splitting words.
For other queries, preserve display text while folding comparison forms and matching every word in name, region, or category.
Bound queries to 512 bytes and eight words.
Rank name matches before matches requiring region or category.
Generate shared kanji folds from pinned Joyo and Unihan records.
Preserve normalized-name ordering and stable identifiers.

## Alternatives

Whole-query substrings miss separated words.
Unrestricted synonym expansion introduces unsupported identities.

## Consequences

Broad region queries return many facilities.
Fold changes require new import identities and compatible saved generations.
Reconsider bounds when measured query costs or supported inputs change.

## Confirmation

The [reading contract](../search-readings.md) and [ranking contract](../search-ranking.md) define current behavior.
Shared fixtures check platform agreement.
Generation checks verify pinned sources, and proofs check bounded ranking decisions.
