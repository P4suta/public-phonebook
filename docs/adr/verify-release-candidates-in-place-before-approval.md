---
date: 2026-11-02
---

# Verify release candidates in place before approval

## Status

Proposed.
The [GitHub deployment proposal](deploy-tested-worker-builds-through-github-actions.md) replaces the candidate coordinator described here.

## Context

The former staging Worker had different bindings and required a rotating Access token.
Rebuilding after staging meant the approved bytes differed from the published bytes.

## Decision

The historical proposal uploads a preserved build as a production Worker version at zero traffic.
Version-override requests check candidate responses before environment approval.
Promotion requires the same candidate and predecessor identities, then moves traffic to the candidate.
A failed public check restores the retained predecessor.
A remote lease serializes effects, while a journal records uncertain transitions.

## Alternatives

Separate staging preserves different bindings and repeated imports.
Rebuilding production discards the checked build identity.
The replacement proposal uses GitHub artifacts and protected deployment of Cloudflare Build Output.

## Consequences

Version overrides and provider state remain external trust boundaries.
The coordinator adds maintenance and recovery logic.
Reconsider in-place candidates if future stateful features require isolation beyond immutable datasets.

## Confirmation

Historical lifecycle tests covered staging, withdrawal, promotion, and restoration.
The [deployment runbook](../deployment.md) defines the replacement's required publication and rollback exercise.
