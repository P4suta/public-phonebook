---
date: 2026-11-01
---

# Keep release records in a conditionally written control bucket

## Status

Proposed.
The [GitHub deployment proposal](deploy-tested-worker-builds-through-github-actions.md) replaces Worker publication coordination while retaining historical records and dataset preparation.

## Context

Checkout-local journals can't coordinate different machines or provide another runner with recovery history.

## Decision

The proposal stores immutable blobs and append-only history in private R2 storage.
Create-only writes use `If-None-Match`, and mutable heads use `If-Match` with the observed entity tag.
Resolve uncertain writes by reading their bytes back.
Serialize data preparation with a renewable lease based on provider time.
Stop effects after lease loss.
Keep credentials in scoped environment variables and outside Worker bundles.
Historical import remains an explicit operation.

## Alternatives

Local locks can't coordinate hosts.
A Durable Object would introduce another deployed service for contributor operations.

## Consequences

Preparation depends on R2 availability, conditional-write behavior, and provider time.
Permanent records consume retained storage.
Reconsider coordination when preparation no longer needs cross-host exclusion.

## Confirmation

Store and lease tests exercise conflicting writes, uncertain outcomes, expiry, and ownership.
The [deployment runbook](../deployment.md) describes current GitHub publication and provider recovery.
