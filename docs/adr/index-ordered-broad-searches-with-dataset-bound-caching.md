---
date: 2026-10-31
status: Proposed for local review
---

# Index-ordered broad searches with dataset-bound caching

## Status

Proposed for local review.
This partly supersedes [category previews with independent continuation](category-previews-with-independent-continuation.md) for previews without a name or telephone term.

## Context

D1 runs one query at a time per database, so the cost of one request bounds the throughput of every other search.
On the retained national bundle of 667,696 contacts, a search without a name term ordered by a constant rank before the normalized name.
SQLite therefore scanned and sorted every matching row instead of reading the `contact_name` index, and each continuation repeated that work.
Every page also counted its complete result, and the unfiltered category preview computed window functions over every contact.
Those requests read 0.6 to 1.3 million rows each and took about 0.1 to 0.9 seconds locally.
Search responses for one dataset never change, but nothing reused them.
The public ordering, totals, cursors, and response shapes are an existing contract that clients and the native app rely on.

## Decision

A search without a name term orders by normalized name and stable ID only, because its rank is constant.
Its continuation compares `(normalized_name, id)` as a row value, which SQLite answers from the `contact_name` index.
Cursors keep their rank field, so a cursor issued before this decision continues to the same next page.

A search with no text term takes its total from the active catalog when the catalog holds that exact count: the complete directory, one prefecture, or one category.
Every other scope, including municipalities, combined filters, names, and telephone numbers, still counts its rows.

The unfiltered category preview reads up to three rows per populated catalog category from the `contact_category` index in one statement and takes each category total from the catalog.
Filtered and named previews keep the ranked window query.

The four search routes reuse successful responses through the Workers Cache API.
The key is the complete request URL qualified by the deployed Worker version ID and dataset manifest SHA-256.
Only status 200 responses are stored, with their own edge lifetime; clients receive the unchanged `Cache-Control` header and a fresh request ID.
The lookup runs inside the Worker after the staging Access check, and a cache failure falls back to the database.
Server rendering calls the same handler through the public origin, so rendered and browser searches share entries.

## Consequences

Broad searches and their continuations read only the rows they return, and repeated searches for one dataset need no database query.
Exact catalog totals depend on the catalog partition that the data gate verifies for every published bundle.
A catalog that disagreed with its contacts would publish a wrong total instead of failing, so that gate remains a release requirement.
Prefecture-only pages still sort the prefecture's rows because no index orders that scope by name; adding one would change the published database.
Telephone-only and single-character name searches keep their previous cost.

The Worker version in the key keeps a release, and its public verification, from receiving responses that the previous code produced.
A request without a version binding or dataset digest bypasses the cache.
Cloudflare does not provide the Cache API to Workers fronted by Access, so staging exercises the database path.
The cache is local to each data center and does not collapse concurrent misses.

Counting every result was kept for scopes without an exact catalog count rather than reporting a lower bound, because the API documents exact totals.
A new composite index for prefecture and name was rejected for this change because it requires preparing and publishing a new database.
Workers Caching in front of the Worker was rejected because it would answer before the in-Worker staging check and needs deployment configuration.
Keying the cache by path alone was rejected because responses contain absolute links for their request origin.

## Assurance and limits

The total-source and cache-admission decisions have source-translated contracts with negative controls.
Native D1 tests require every broad search page, preview, vCard page, and pre-change cursor to produce the same bytes as the window-ranked implementation.
They also check catalog-total sources, cache hits without a database, digest separation, and refusal to store problem responses.
A query-plan test requires the `contact_name` and `contact_category` indexes and rejects the constant-rank ordering as a negative control.
SQLite planning, D1 latency, and the Cloudflare cache remain external semantic boundaries; the local plan and timing evidence doesn't establish production capacity.
See [verification contracts](../verification.md) and [native API tests](../../tests/unit/api.test.ts).

## Related decisions

- [Category previews with independent continuation](category-previews-with-independent-continuation.md)
- [Provide a public read API with snapshot identities](public-read-api-with-snapshot-identity.md)
- [Authenticate the entire staging origin](authenticate-the-entire-staging-origin.md)
