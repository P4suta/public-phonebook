---
date: 2026-11-05
---

# Select delivery operations independently from required checks

## Status

Proposed.
It extends [input-bound candidate evidence](bind-candidate-evidence-to-the-files-each-stage-reads.md) and changes retry numbering from [the original TestFlight allocation](number-testflight-builds-from-the-workflow-run.md).

## Context

The website, two native clients, datasets, notification policies, and uptime checks publish through different operations.

## Decision

A typed Rust command selects independent operations and keeps an immutable plan, and target selection never removes a mandatory check.
Each app prepares its version in its own release-please configuration, and a retry keeps the original store build and package.
The [delivery design](../delivery.md#design) gives the evidence, signing, and configuration rules.

## Alternatives

One global version and rollout couples unrelated store and infrastructure operations.
Per-directory version filtering misses shared generators.

## Confirmation

Kani proofs, tests, mutation campaigns, and provider fixtures cover the decisions that the runbook lists.

## Consequences

A new dispatch fails once `main` advances, and the owner archives artifacts before they expire.
