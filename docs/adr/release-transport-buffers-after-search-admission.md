---
date: 2026-11-08
---

# Release transport buffers after search admission

## Status

Proposed.

## Context

Compact literal columns still keep the full decoded transport buffer through byte views.
That buffer holds both normalized and display names, although validation no longer needs the normalized copy.

## Decision

After complete validation, keep display names and folded names in bounded text chunks.
Copy only category, region, and telephone bytes into column-owned storage.
Construct readers outside the transport decoder's closure so they can't hold its byte views.
Preserve the format, full corruption rejection, and search contract.

## Alternatives

Borrowing the transport buffer avoids copying but retains redundant name bytes and permits later input mutation to alter admitted data.
A smaller wire format needs a separate producer migration.

## Consequences

Admission holds both the transport and retained columns until it returns.
Names reconstruct their normalized form only when a result needs a row.
The transport buffer becomes collectible after admission returns.

## Confirmation

Require transport-mutation isolation, malformed-input rejection, national parity, and four attributed browser measurements.
Reconsider when copying increases the measured peak or changes search behavior.
