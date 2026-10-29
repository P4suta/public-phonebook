---
date: 2026-10-29
---

# Count published contact points and declare nationwide categories

## Status

Proposed.
Implemented for the public-data expansion.
This extends the identity and category completeness rules in [the SQLite snapshot decision](sqlite-national-snapshots.md).

## Context

Care and disability publishers repeat office contact details across service lists.
Counting each service row would duplicate identical callable contacts.
Telephone numbers alone don't identify an institution because separate offices can share a number.
The cultural institution registers also provide useful records without promising exhaustive geographic coverage.

## Decision

Keep care and disability contact identities within their category.
Derive their IDs from normalized names, normalized addresses, and canonical telephone sets using SHA-256.
Keep the first source record in deterministic file order and account for repeated contact points in the source reports.
Keep a distinct contact when any of those identity fields differs.
Use the published institution identifier for library, museum, and archive records.
Keep records in different categories separate.
Use the same content identity for childcare facilities and civic or education contact points.
Keep the published school code as provenance rather than using it to merge records across categories.

Require each declared nationwide category in all 47 prefectures before activating a snapshot.
Keep other category zero cells explicit without claiming nationwide coverage for those lists.
Apply this partial-coverage rule to specialized services and institution types that have no published location in some prefectures.
Preserve source bytes, release inventories, publisher pages, reuse terms, and row reconciliation.
The optional expansion check requires that a saved earlier snapshot's contacts remain unchanged.
Keep childcare admission and table-span bounds in the pure Rust core with source-bound Kani harnesses.
Treat document parsing and publisher truth as external boundaries checked by native fixtures, archived inputs, data reconciliation, and browser workflows.
Omit individual childcare providers and inactive facilities, and label coarse police or fire administrative locations explicitly.

## Consequences

Contact counts measure published contact points and are separate from distinct telephone counts and legal-entity counts.
A derived ID can change when its normalized name, address, or telephone set changes.
Similar names and cross-category records can remain separate because the importer performs no fuzzy entity matching.
Hash collision resistance and the publishers' identity and address statements remain trust assumptions.

Keeping one row per service would inflate identical contact listings.
Merging by telephone number would lose distinct institutions.
Requiring every cultural category in every prefecture would prevent importing useful partial registers.
These alternatives don't meet the directory's contact and coverage contracts.
