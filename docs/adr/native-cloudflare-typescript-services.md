---
date: 2026-10-30
---

# Use native Cloudflare TypeScript services

## Status

Accepted for local implementation.
The owner authorized a fresh TypeScript architecture and limited this delivery to local review.
This supersedes the local application and API mechanisms in [Rust snapshots](immutable-rust-snapshots-on-cloudflare.md), [SQLite snapshots](sqlite-national-snapshots.md), and [the read API](public-read-api-with-snapshot-identity.md).
The original local implementation did not alter the existing public deployment.
The [staging promotion decision](source-tree-bound-staging-promotion.md) extends this boundary for publication.

## Context

Visitors need direct access to telephone numbers and usable search on narrow screens.
External developers need complete public data without scraping the website.
The collected records and provenance are valuable, while the Rust application, Container lifecycle, rendering templates, and fixed-page API need no compatibility layer.
A national archive is too large to send to every visitor.

## Decision

Use TypeScript throughout owned application, API, data tooling, and verification code.
Use TanStack Start and React for server-rendered routes and native-form fallbacks, TanStack Query for cached automatic search and continuation, Hono for public HTTP contracts, Valibot for external values, and Drizzle for typed D1 queries.
Use Vanilla Extract and shared black-and-white Figma components for the interface.
Use native Workers, D1, and R2 through typed cf configuration, without a Container.
Keep development, staging, and production resource identities separate.
Production's configured site is www.dial.page and the apex is unassigned.

Keep normalization, input contracts, cursor decisions, representations, and page-chain checks in the pure core.
Keep database, HTTP, filesystem, randomness, browser, and Cloudflare effects behind adapters.
Derive binding types from the configuration and validate JSON as unknown at boundaries.
Use exact-name, prefix, and substring ranks followed by normalized name and stable ID.
Use snapshot-bound keyset cursors with fixed-size query digests and bounded sortable fields.
Prepare complete archives before serving them and address downloads by archive digest.
Expose record provenance and source-specific reuse metadata through the same read API used by the website.

Import the preserved complete SQLite publication with a TypeScript adapter and retain its digest.
Reject malformed contacts, missing source references, conflicting regions, incorrect counts, and invalid prepared artifacts before local activation.
Keep upstream collection as a separate data acquisition boundary; the retired collectors are not retained as application dependencies.

Require strict types, semantic linting, deterministic properties, native D1 contracts, built-browser checks, and source-bound proofs for the supported pure decisions.
Keep compiler output, native codecs, SQLite, browser scheduling, and the Cloudflare runtime as explicit semantic boundaries.
The [verification contract](../verification.md) defines their complementary checks and limits.

## Consequences

The browser gets server-rendered content and automatic cached searches without downloading the national archive.
Anonymous API consumers can follow stable continuation links or download complete files with checksums.
Source-specific provenance remains available before a publisher file is opened.
A failed local preparation leaves the input publication intact.
Local verification needs no Cloudflare account or application secret.

The cf CLI, Vite plugin, and runtime integration include pinned beta interfaces and require integration checks on upgrades.
A new source collection still requires a complete checked publication before preparation.
Remote import, environment protection, production capacity, exact-candidate deployment, and rollback are not established by local tests.
A Container would add an unnecessary lifecycle boundary to the chosen native stack.
A browser-only national database would impose large transfers and parsing work on every visitor.
An account-based API would add identity and credential administration to public reads.
