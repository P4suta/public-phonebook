---
date: 2026-10-30
---

# Share directory snapshots with iOS extensions

## Status

Accepted.
[National import](import-the-national-dataset-for-ios-extensions.md) supersedes region selection and paged import.
[Saved search](search-the-saved-directory-on-the-device.md) supersedes API search, opt-in updates, and Contact Provider.

## Context

The host app and independently scheduled extensions need a consistent directory despite interrupted updates.

## Decision

Keep SwiftUI adapters and local Swift packages under `apps/ios`.
Store immutable validated generations in an App Group.
Prepare extension projections before atomically replacing the active manifest.
Serialize publishers across processes and keep the current and previous generations.
Project caller entries by canonical telephone number and preserve ambiguity when distinct names share a number.
Keep caller identification optional.
Treat background scheduling as an operating-system boundary.

## Alternatives

Mutating the active database exposes partial updates.
Separate extension databases duplicate validation and risk inconsistent generations.
Personal contacts mix ownership with public records.

## Consequences

Interrupted updates preserve the active directory.
Retained generations cost disk space, and delayed readers may need to restart.
Reconsider shared storage if supported extensions no longer require it.

## Confirmation

The [Apple runbook](../ios.md) defines generation, projection, package, and physical-device checks.
Store tests exercise incomplete publication, retained reads, and recovery.
