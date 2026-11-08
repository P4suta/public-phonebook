---
date: 2026-11-08
---

# Measure each search mode with its interaction budget

## Status

Proposed.

## Context

The production worker returns literal category previews without a ranking companion.
The performance report applies the experiment's complete-ranking thresholds even when no ranking contract runs.

## Decision

Read the mode from the actual worker load request.
Build the measured mode from current sources before starting the browser campaign.
Keep the 1,500 ms admission and 400,000,000-byte added browser-process budgets for both modes.
Use a 50 ms p95 budget for sampled literal worker round trips, adopting the input-processing guideline in Google's [Response, Animation, Idle, and Load (RAIL) model](https://web.dev/articles/rail).
The clock ends at the worker response.
Preserve the 10.2, 11.2, 10, and 13 ms complete-ranking thresholds for the explicit forgiving-search contract.
Missing measurements remain null and can't pass.

## Alternatives

Requiring the frozen ranking fixture for every build measures an experiment that production omits.
A universal threshold loses the historical ranking comparison.

## Consequences

Browser profiles remain conditional measurements rather than physical-phone results.
Reconsider the literal budget when the interaction or supported device population changes.

## Confirmation

Require boundary, missing-measurement, mode-selection, and regression cases.
Measure all four national profiles with process attribution and preserve national query and continuation parity.
