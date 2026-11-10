---
date: 2026-11-03
---

# Serve the directory JSON to the site only

## Status

Accepted.
[Dataset formats](declare-dataset-file-formats-instead-of-api-versions.md) supersede versioned listings.
Supersedes the [public API](public-read-api-with-snapshot-identity.md), [server reference](server-rendered-api-reference.md), and [interactive reference](openapi-driven-interactive-reference.md).

## Context

The owner retired the public search API while preserving equal access to complete datasets and provenance.
Removing documentation alone would leave a discoverable public interface.

## Decision

Separate open dataset listings and downloads from website search, contacts, sources, and catalog routes.
Open data keeps cross-origin access.
Website routes omit cross-origin permissions, reject explicit cross-site fetch metadata, and bound search pages to 30 rows.
Requests without fetch metadata remain admitted for server rendering and verification.
Remove developer documentation and OpenAPI viewers.

## Alternatives

Documentation removal leaves the API operational.
Accounts or API keys introduce identity management for a public-data service.

## Consequences

Browser metadata restricts cross-site use without authenticating arbitrary clients.
Rate limits bound extra traffic.
Native apps continue downloading complete files.
Reconsider a public API when maintained external consumers require one.

## Confirmation

Tests and source-bound proofs check route admission, page bounds, and native download compatibility.
The [open data guide](../api.md) defines current formats.
