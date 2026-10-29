---
date: 2026-10-29
---

# Provide a public read API with snapshot identities

## Status

Proposed for publication.
Implemented locally.
This extends [immutable Rust snapshots on Cloudflare](immutable-rust-snapshots-on-cloudflare.md).

## Context

Public organizational contact data must be reusable by external developers without HTML scraping or account administration.
Consumers need complete records, source-specific reuse information, efficient bulk retrieval, and a way to avoid combining data from different updates.
The website's enhancement feed returns rendered cards and is coupled to its presentation.

## Decision

Provide an anonymous read API under `/api` with discovery, search, individual contacts, source reports, the filter catalog, and streaming exports.
Keep the enhancement feed under `/internal/search`.
Use the same checked search model, database, capacity limits, and export producer as the website.
Return provenance and reuse fields with each contact.
Expose complete-result download links so consumers can reuse a dataset without issuing thousands of page requests.

Use origin-relative links carrying the current database identity.
Reject a different supplied identity with 409 before reading or exporting records.
Reuse the proved page window for fixed-size pagination and reject invalid requested pages explicitly.
Keep snapshot syntax and the finite problem policy in the production Rust core.

Generate OpenAPI 3.1 from the Rust DTOs and the actual export serializer with pinned Utoipa.
Validate real response fixtures with an independent JSON Schema implementation and require malformed-response controls to fail.
Return RFC 9457 problems and expose correlation, snapshot, and retry headers to anonymous browser clients.
Keep browser security protections in place and test cross-origin access with a real local consumer origin.

## Consequences

Developers can read structured data, discover filter values, follow provenance, and download complete selections without parsing the website.
Public reads need no credentials or user account storage.
Clients must restart incomplete pagination when an update changes the database identity.
The snapshot identifies database content rather than every possible serialized representation.
Source licensing remains record-specific.

Requiring API keys would add account and secret management to a public read service.
Publishing only rendered cards would couple consumers to presentation changes.
Pagination without an identity check could silently combine different snapshots.
Duplicating the database adapter or bulk serializer would create another implementation to reconcile.

The HTTP framework, serializer, schema generator and validator, browser networking, and Cloudflare runtime remain external semantic boundaries.
Source-bound core proofs, native contract checks, fault injection, and actual browser and local Worker checks cover their assessed contracts without claiming a proof of the entire service.
The [API guide](../api.md) and [verification boundaries](../verification.md) describe those contracts.
