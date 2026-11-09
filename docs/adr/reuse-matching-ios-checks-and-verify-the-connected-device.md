---
date: 2026-11-09
---

# Reuse matching iOS checks and verify the connected device

## Status

Proposed.

## Context

Candidate and TestFlight repeat native checks that took 50 minutes in [run 42321778366](https://github.com/P4suta/public-phonebook/actions/runs/42321778366).
The platform verifier compares inputs but omits native output receipts.

## Decision

Share matching check-only results and SHA-256-bound output receipts.
Missing or changed results rerun verification.
Serialize matching native jobs and preserve every release gate.
Run independent checks concurrently.
Unsigned preparation waits for every check.

Run the read-only live UI case on the connected iPhone with VerificationRelease and local QA signing.
Validate XCTest results and preserve production data.
Also test the preserved TestFlight build before review, following [Apple](https://developer.apple.com/documentation/xcode/testing-a-release-build).

## Alternatives

Repeated verification costs another run.
Device-only verification loses controlled failure scenarios.

## Consequences

Reuse trusts GitHub's [branch isolation](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).
Reconsider if untrusted workflows gain cache writes.
QA signing differs from App Store signing.
Keep product telemetry off.

## Confirmation

Tests reject stale inputs, missing outputs, and incomplete UI results.
Run the device command and workflow gates.
