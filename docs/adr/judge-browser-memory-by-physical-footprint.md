---
date: 2026-11-08
---

# Judge browser memory by physical footprint

## Status

Proposed.
The owner selected physical footprint as the primary metric.

## Context

The national experiment still exceeds its 400,000,000-byte added resident-memory target.
Resident size includes clean mapped pages, while [Apple's memory guidance](https://developer.apple.com/videos/play/wwdc2022/10106/) uses physical footprint when assessing process limits.
The local sampler now records both counters.

## Decision

Keep the 400,000,000-byte threshold and existing latency budgets.
Use sampled physical-footprint growth for memory eligibility on supported macOS hosts.
Require the complete owned process inventory and refuse unavailable counters.
Preserve resident costs and their historical budget verdict beside the primary verdict.
Make the selected metric explicit in every report.

## Alternatives

Resident size preserves historical comparison but counts clean mapped pages.
JavaScript heap alone omits backing buffers and native browser storage.
Increasing the threshold supplies no better attribution.

## Consequences

Historical resident-memory verdicts keep their meaning.
An over-budget physical-footprint sample still fails.
Native lifetime peaks can lag a current reading, so preserve both raw values and judge sampled current growth.

## Confirmation

Require missing-counter rejection, opposite resident and footprint verdicts, and all four national profiles.
