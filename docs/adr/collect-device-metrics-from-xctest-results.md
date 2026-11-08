---
date: 2026-11-08
---

# Collect device metrics from XCTest results

## Status

Proposed.

## Context

The physical baseline fails in `MXMCPUMetric` while collecting wrapped built-in metrics.
The host app also starts ordinary synchronization during the experiment.

## Decision

Pass Apple's [built-in metrics](https://developer.apple.com/documentation/xctest/xctmetric) to XCTest and read their values through `xcresulttool get test-results metrics`.
Attachments identify the path, iteration count, and store sizes.
Require the named test case, finite repetitions, units, and CPU, clock, memory, and storage families.
Keep the host idle through a QA-only [scheme argument](https://github.com/yonaskolb/XcodeGen/blob/2.46.0/Docs/ProjectSpec.md#common-build-action-options).
Reject locked devices before preparation and reopen interactive QA after measurement returns.

## Alternatives

Metric wrappers collect values within the test but hide the concrete framework metric.
Console parsing couples the reader to diagnostic text.

## Consequences

The result bundle becomes authoritative for metrics.
Missing CPU counters fail the experiment.
The QA argument must remain absent from Release.
Reconsider the parser when Xcode changes its result schema.

## Confirmation

Require malformed-case and missing-metric controls, the Release exclusion gate, and all three physical paths with the declared repetitions.
