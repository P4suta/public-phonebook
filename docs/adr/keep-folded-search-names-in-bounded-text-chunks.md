---
date: 2026-11-08
---

# Keep folded search names in bounded text chunks

## Status

Proposed.

## Context

The [compact columns](keep-validated-search-columns-compact.md) keep one comparison string per contact.
Attributed browser measurements still exceed the 400,000,000-byte added resident-memory budget.
The national directory contains 672,133 contacts.

## Decision

Validate every name before admission and keep folded names in chunks of 512 newline-terminated rows with UTF-16 offsets.
Find each word within each chunk and record its name rank in one byte per contact.
Reject matches across row boundaries.
Combine name ranks with the existing place predicates and ranking policy.
Read individual comparison strings only when a caller requests them.
Keep the published index and native archive formats.

## Alternatives

Individual strings simplify row scans but keep one string object per contact.
Byte-only matching adds UTF-8 matching rules.
Published postings require artifact migration and preparation work.

## Consequences

Eight query words use at most eight transient rank bytes per contact.
Queries scan rank bytes and place columns without creating name strings or row callbacks.
Reconsider the representation if measured admission, interaction, or process-memory budgets fail.

## Confirmation

Require zero comparison-string reads, independent Unicode and category parity, boundary rejection, corruption rejection, and all four attributed national measurements.
