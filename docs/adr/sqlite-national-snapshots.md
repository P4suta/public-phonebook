---
date: 2026-10-29
---

# Search complete national snapshots in SQLite

## Status

Accepted.
[The published-contact decision](published-contact-points-and-coverage.md) extends the identity and coverage rules.

## Context

A public contact directory needs useful national coverage, traceable source data, and portable downloads.
The first supported sources are insurance-designated medical facilities, dental facilities, pharmacies, municipal offices, and prefectural offices in Japan.
Private contacts and device address books are outside the data boundary.

## Decision

Use a local Rust application with server-rendered HTML and an indexed SQLite snapshot.
Keep phone normalization and vCard text handling in the dependency-free `phonebook-core` crate.
Keep network access, source parsers, database access, and HTTP delivery in adapters.

Retain source bytes by SHA-256 and distinguish source dates from retrieval dates.
Require all five categories in every prefecture and reconciled source counts before activating a snapshot.
Reject ambiguous facility identities instead of merging records by telephone number.
Preserve the previous database when retrieval, parsing, validation, or staging fails.
Prevent updates while the server holds a shared directory lock.

Search normalized names by substring and complete normalized telephone numbers by exact match.
Return 50 contacts per HTML page.
Export every matching record as UTF-8 JSON, CSV, or vCard 3.0, independently of pagination.
Generate exports through a database cursor and stream the prepared temporary file over HTTP.

## Consequences

SQLite keeps setup local and supports indexed telephone, region, and category lookups.
Data updates require stopping the local server.
Each update downloads or reuses the full source inventory before activation.
Source publications can lag real changes and include suspended facilities.
Municipality attribution depends on published addresses and the municipal reference catalog.

A static JSON-only directory would move national parsing and filtering into every browser.
A hosted database would introduce infrastructure and account management before local usefulness is established.
Native address-book synchronization would require platform-specific account, permission, conflict, and background-update behavior.
These alternatives do not improve the initial local search and export contract.

Source-bound Kani checks cover the fixed-digit normalization core and single-byte vCard escaping.
Integration tests and a real-data audit cover the database and HTTP boundaries.
These checks do not certify that a published telephone number still belongs to an institution or that physical devices import every vCard identically.
