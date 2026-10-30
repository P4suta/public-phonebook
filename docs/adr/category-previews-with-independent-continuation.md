---
date: 2026-10-30
status: Proposed for local review
---

# Category previews with independent continuation

## Status

Proposed for local review.

## Context

A flat stream can let a large category occupy the first screen while other matching facility kinds remain hidden.
Search should provide useful initial candidates without requiring a grouping selector or mandatory filters.
The website and external developers need the same validated, public read contract.
The retained dataset and its existing flat pagination remain authoritative.

## Decision

Add `/api/contact-groups` as an additive public endpoint.
An unselected category search returns up to three contacts per matching category, reduced when the requested limit is smaller.
A parameterized SQLite window query ranks narrow candidate rows within each category and counts that category's complete matches.
Payloads are retrieved only for selected previews.
Category order follows the best contact under the existing exact-name, prefix, substring, normalized-name, and stable-ID ranking.
A category-selected request delegates to the existing flat search.
Each preview's continuation uses the flat endpoint with that category and the original page-size, query, and snapshot cursor bindings.
There is no request per category.

The website promotes up to three exact-name contacts before category sections and removes those identities from the repeated presentation.
Each remaining section has one icon, a literal category name, a matching count, and third-level facility headings.
Opening its continuation adds contacts to that section without changing the search filters.
Automatic continuation is gated by explicit expansion or category selection.
Native links retain a usable no-JavaScript path.

## Consequences

Initial contact payloads are bounded by category count rather than the size of the largest category.
Broad database queries still pay for partition counting and sorting.
The added endpoint preserves the existing flat API and requires validation of its grouped response and independent cursor chains.

Flat global pagination was rejected because a large category can fill the initial screen.
Grouping successive flat pages only in the browser was rejected because late arrivals can grow earlier sections and move later results.
One initial request per category was rejected because the request count would grow with the taxonomy.
A visitor-selectable grouping mode was rejected because the product uses one consistent facility-category presentation.

## Assurance and limits

The preview-size policy has source-translated contracts for all admitted integer page sizes.
Native D1 tests compare counts and complete traversal without missing or repeated records.
Valibot rejects duplicate categories, repeated identities, foreign-category rows, inconsistent totals, and mixed snapshots.
Browser checks cover the fixed headings, exact-name promotion, independent expansion, keyboard semantics, and native continuation.
SQLite, Unicode normalization, React caches, and browser geometry remain explicit semantic boundaries.
See [verification contracts](../verification.md), [native API tests](../../tests/unit/api.test.ts), and [browser contracts](../../tests/browser/category-results.spec.ts) for the checked alternatives.

Name matching supplies a reproducible initial order and does not establish a visitor's intent.
Ambiguous names retain multiple candidates.
Records that share a name or telephone number remain distinct until a separate, provenance-preserving identity policy is established.
This design is available for local review and does not authorize production deployment.

## Related decisions

- [Native Cloudflare TypeScript services](native-cloudflare-typescript-services.md)
- [Published contact points and coverage](published-contact-points-and-coverage.md)
