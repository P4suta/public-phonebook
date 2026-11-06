---
date: 2026-11-06
---

# Keep forgiving ranking outside the shipped core

## Status

Proposed.

## Context

The core mutation profile mutates every file under `ios/Sources/PhonebookCore` and runs `PhonebookCoreTests` on each mutant.
The forgiving ranking files sat in that directory, while their tests ran in `PhonebookKitTests`.
TestFlight run 42098932498 stopped on 485 uncovered ranking mutants.
[Forgiving search ships only in QA builds](keep-forgiving-search-in-qa-and-local-development.md).

## Decision

A `PhonebookRanking` target holds the forgiving ranking code, depends on `PhonebookCore`, and serves `PhonebookKit`.
Its tests run in `PhonebookKitTests`, and the core mutation profile covers the shipped core alone.

## Alternatives

Ranking tests in `PhonebookCoreTests` keep one target but add about 570 QA-only mutants to every TestFlight run.
An exclusion list in the mutation plan conflicts with the gate, which requires an empty one.

## Confirmation

`just ios-mutate` passes the core profile, and `just ios-search-measure` replays the national fixture through the new target.

## Consequences

The QA-only ranking code has no mutation gate until a ranking profile exists.
