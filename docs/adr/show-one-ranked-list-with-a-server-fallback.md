---
date: 2026-11-05
---

# Show one ranked list with a server fallback

## Status

Accepted.
The implementation brief approves this presentation and execution policy.
It supersedes the website presentation in [category previews](category-previews-with-independent-continuation.md) and the ranking-parity rule in [browser search](search-in-the-browser-once-the-index-loads.md).
Phase 1 supplies the core and contracts, while phase 2 connects the website and iPhone screens.

## Context

Three previews per category can hide a stronger candidate below category sections.
Forgiving facility-name search needs one global ordering for the first candidates.
The train-selected single-result rule admitted 272 of the 564 validation queries, with 255 correct first results.
Its observed precision was 93.75%, below the 95% target, and its coverage was 48.23%.
That result doesn't justify a single-result mode.

Running fuzzy posting aggregation through local D1 took 121.418 ms at p95, before network transport.
The median query read 263,394 rows, with 994,924 at p95.
Those measurements concern the local national-data experiment and don't measure deployed capacity or billing.
The server still needs to serve readers without JavaScript and searches made before device artifacts load.

## Decision

Present one ranked list with category and region on each result.
Keep competing candidates and provide no automatic single-result mode.
Use the [frozen device scorer](rank-device-search-with-place-preferences-and-gated-readings.md) after both snapshot artifacts pass admission.
Until admission, and without JavaScript, keep the existing server matcher and show its existing rank order in the same single-list presentation.
The server orders exact names, prefixes, substrings, and place matches under its current deterministic name and ID ties.
Device search orders the frozen scorer's bounded candidates.
Match complete telephone numbers through the existing path.

Keep the existing browser transition after its index loads and continue serving on the server when loading or admission fails.
Require the name and ranking artifacts to share the snapshot and contact count, and verify their decoded lengths and hashes before constructing device search.
Keep fuzzy ranking on devices.
Maintain device-to-device ranking parity and check the server's preserved matching contract on its own fixtures.

The [W3C content-structure guidance](https://www.w3.org/WAI/tutorials/page-structure/content/) associates ordered lists with sequential information and requires semantic grouping.
Phase 2 should express the ranking order programmatically and keep each result's category and region associated with its facility link.
The owner-approved single-list design determines the product layout.
The accessibility guidance determines its semantic expression.

The iPhone uses one sequence of saved contact identifiers in scorer order.
Each facility keeps its name heading, category and region text, telephone actions, and detail action in one accessibility container.
Apple's [list guidance](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables) supports succinct text rows and detail navigation.
Its [VoiceOver guidance](https://developer.apple.com/design/human-interface-guidelines/voiceover) requires meaningful headings and explicit grouping and order.
The [accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility) supports Dynamic Type and sufficiently sized controls.
The app keeps native text styles and controls at least 44 points high.
An explicit page action appends 20 results and moves VoiceOver focus to the first new facility heading.
Editing the query preserves the search field's focus and announces the returned count after the existing pause.
The input reaches the scorer with its original spelling and word boundaries.
The app keeps the literal matcher for a saved generation whose search migration hasn't succeeded.

## Consequences

The initial server result can change after device search becomes ready because the two engines answer different matching policies.
The adapter must preserve focus and use the existing loading and failure transitions during that replacement.
Category and region disambiguate similarly named facilities inside one ranking.
The existing group endpoint and current screens remain operational during phase 1.

Single-result presentation would hide alternatives despite the failed precision target.
Keeping three results per category would preserve the earlier grouping at the cost of the chosen global relevance order.
Server-side fuzzy ranking would add the measured posting work to every server request.
The decision trades exact server/device equality for a bounded server fallback and improved measured device ranking.
It leaves deployment, physical-device performance, and screen integration to their authorized later stages.
