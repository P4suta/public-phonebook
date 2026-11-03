---
date: 2026-11-03
---

# Bind candidate evidence to the files each stage reads

## Status

Proposed.
It amends [run only the fast gate on pull requests and verify at the release gate](run-only-the-fast-gate-on-pull-requests-and-verify-at-the-release-gate.md) and [keep release records in a conditionally written control bucket](keep-release-records-in-a-conditionally-written-control-bucket.md).

## Context

Candidate evidence named the Git tree and the dataset manifest, so a change to any file made every stage run again before a release.
[Candidate run 41580667170](https://github.com/P4suta/public-phonebook/actions/runs/41580667170) took 59 minutes:
- The iOS checks took 27 minutes on the macOS runner, and the evidence job waited for them before it started.
- The evidence job took 31 minutes, and it ran `just check-build` and `just prove` again after the assurance jobs had run them.
- The assurance jobs recorded nothing, so the evidence job repeated their checks to record them.

A page change reads none of the native files, yet it still waited for the iOS checks.
`tools/ios-check` already hashes a declared scope of files for its own receipts.

## Decision

Bind each stage's evidence to the SHA-256 of the stage's declaration and the Git object IDs of the tracked files it reads.
Include the dataset manifest in that digest only for the stages that read the dataset: `data`, `phones`, `parity`, and `e2e`.
`tools/stage-inputs.ts` declares the files:
- `check` and `prove` read every tracked file.
- `data`, `phones`, `parity`, and `e2e` read every tracked file except `ios`, `verification/ios`, and `tools/ios-check`.
- `ios-prove` and `ios-check` read the scope that `tools/ios-check` hashes, plus `candidate.yml`, and a unit test requires the two lists to match.

An exclusion names only paths a stage never reads, so a missing exclusion costs a run and never admits stale evidence.

Record the iOS proofs and the iOS checks as candidate stages, so production admits them through the same rule.
The candidate workflow first lists the stages without admitted evidence.
It then runs each listed stage once, in its own job, and the jobs run in parallel.
The data job's fetch runs the complete bundle check, which is the `data` stage.
A final job records every listed stage whose job passed, even when another stage failed, and then fails the run if any listed stage didn't pass.
`tools/test.ts` no longer records evidence, so only that job writes it.

Admission keeps its rule, and its stale case is now `stale-inputs`.
The evidence must exist, name the expected inputs and dataset, come from an accepted signer, and record a pass.
Evidence lives at `candidates/INPUTS/STAGE.json` in format 2.

## Consequences

A change outside a stage's inputs reuses that stage's evidence.
A page change runs the Web stages and reuses the iOS evidence, and a native change reuses the dataset stages.
A full run takes about as long as its slowest stage instead of the sum of the iOS checks and the evidence job.
Evidence in the tree-bound format no longer counts, so the first run after this change runs every stage.

The declared inputs become a trust assumption.
A stage that starts to read a file outside its declaration could reuse a pass that the change would break.
Keep the declarations broad, change them with the code that changes what a stage reads, and prefer an extra run to a narrower list.

Rejected alternatives:
- Keeping tree-bound evidence keeps the hour-long run for every change.
- Skipping the iOS checks for Web releases leaves a shared change, such as one under `src/core`, unchecked in the app.
- Workflow path filters decide from a diff with some base commit, while an inputs digest decides from the files themselves.
