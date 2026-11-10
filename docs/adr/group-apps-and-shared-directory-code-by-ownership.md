---
date: 2026-11-10
---

# Group apps and shared directory code by ownership

## Status

Proposed.

## Context

Maintainers need to locate each product, shared directory contracts, dataset preparation, and provider operations without treating the website as the repository root.
The existing tools already support independent app roots.

## Decision

Place the website, Apple apps, and Android app under `apps/web`, `apps/ios`, and `apps/android`.
Keep reusable TypeScript directory code under `packages/directory`, collection inputs and preparation under `data`, and provider operations under `infrastructure`.
Reserve root tooling for repository checks and shared developer entrypoints.

Use [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/) with one lockfile.
Preserve Apple's [local Swift packages](https://developer.apple.com/documentation/xcode/organizing-your-code-with-local-packages) and Android's [Gradle modules](https://developer.android.com/topic/modularization).
The directory names express project ownership.
The platform documentation specifies the package mechanisms.

## Alternatives

The flat layout minimizes migration but preserves ambiguous ownership.
A second build orchestrator would duplicate npm, Xcode, and Gradle coordination.

## Consequences

Imports, generated inputs, CI paths, and documentation migrate together.
Public URLs and stored formats remain compatible.
Reconsider package boundaries when a consumer needs an independently released library.

## Confirmation

Run repository checks, browser and data contracts, Xcode verification, and Gradle checks from the documented entrypoints.
Reject runtime imports from infrastructure and preparation tooling.
