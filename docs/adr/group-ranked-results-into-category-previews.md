---
date: 2026-11-06
---

# Group ranked results into category previews

## Status

Accepted after the owner's 2026-11-06 review of the single list.
It supersedes the presentation in [one ranked list](show-one-ranked-list-with-a-server-fallback.md) and restores [category previews](category-previews-with-independent-continuation.md).

## Context

The single list filled the screen with similar results and lost the category structure.
It rested on 47 of 500 blind targets hidden by previews, without a Figma review.

## Decision

Every surface shows up to three results per matching category and a continuation for that category.
A category's position follows its first result, and results keep their ranking order inside it.
Shipped builds rank literally, and QA and local builds rank with the forgiving scorer before grouping.

## Alternatives

The single list shows hidden targets but overwhelms the screen.
A top-result block above the categories needs a Figma proposal first.

## Confirmation

Browser and iPhone tests check three previews per category, category order, and continuation.

## Consequences

A strong candidate in a later category can sit below other previews.
