---
date: 2026-11-08
---

# Match verified place readings without a ranking companion

## Status

Proposed.

## Context

Kana input misses kanji place and category labels.
The [retired native scorer](keep-qa-search-aligned-with-the-release-app.md) needs larger artifacts and startup work.

## Decision

Ship one checked JSON document for 47 prefectures and verified common category readings.
Keep it as a Swift package resource, import it on the website, and copy it into Android resources.
Use the existing kana and width folding and match reading prefixes of at least two characters.
Keep every matching place and the existing place rank.
Complete numbers and literal name ranks stay unchanged.

Android adds query predicates for category identifiers and archive region prefixes.
Reading words bypass the old full-text prefilter, preserving matches in saved generations.
The publication format stays unchanged.

## Alternatives

Literal matching misses common kana searches.
Reading substrings confuse Tokyo input with the middle of the secondary-school reading.
Per-facility readings require a larger publication contract and proper-name evidence.
Rebuilding Android indexes repeats import work.

## Confirmation

Require shared fixtures, native SQL and iPhone tests, browser parity, and the current worker budget.

## Consequences

Reading matches cover the declared places and categories.
Reconsider municipal or facility readings when their source coverage and resource costs have measured support.
