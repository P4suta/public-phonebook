---
date: 2026-11-03
---

# Bind candidate evidence to the files each stage reads

## Status

Proposed.
The [GitHub deployment proposal](deploy-tested-worker-builds-through-github-actions.md) replaces the publication mechanism described here.

## Context

[Run 41580667170](https://github.com/P4suta/public-phonebook/actions/runs/41580667170) repeated expensive checks because evidence named the whole tree and assurance jobs recorded no reusable result.
A website change waited for unrelated native work.

## Decision

The proposal binds each stage to its declaration and every tracked input it reads.
Dataset-consuming stages also bind the immutable manifest.
Reuse requires matching inputs, accepted provenance, and a passing result.
Run missing stages independently and record successful stages even when another stage fails.

## Alternatives

Whole-tree evidence is conservative but repeats unrelated work.
Diff filters alone can't establish the identity of already verified inputs.

## Consequences

Broad input declarations cost extra runs.
Missing inputs can admit stale results and require review.
Current native reuse additionally binds toolchains and runtime identities.
Reconsider reuse if maintaining complete declarations costs more than rerunning checks.

## Confirmation

The [verification contract](../verification.md) defines the active checks and reuse boundaries.
The replacement workflow must exercise dependencies and rejecting controls before publication.
