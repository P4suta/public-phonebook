---
date: 2026-11-08
---

# Exercise caller replacement with a bounded held fixture

## Status

Proposed.

## Context

The device completes a full national load below 12 MB.
Repeating an unchanged label produces no difference, leaving the large-difference fallback untested.

## Decision

Let the QA app prepare a comparison file containing 1,001 existing national numbers with different labels.
Consume the file once when the extension starts a request.
On an incremental request, use that file only as the held comparison reader.
The normal planner must select full replacement before CallKit receives changes.
The desired entries and loaded record remain the actual current directory and controlled test number.
Always remove the consumed fixture.
Record the context's incremental flag and chosen plan in the existing completion notice.

## Alternatives

Waiting for a large publication gives no reproducible device scenario.
Changing installed facility labels creates unnecessary visible test data.

## Consequences

The fixture tests a synthetic comparison through the real CallKit request.
It doesn't establish every natural generation transition.
Keep every fixture entry point and marker absent from Release.

## Confirmation

Require source preservation, the 1,001-entry fixture, single consumption, Release exclusion, and successful physical small and large changes.
