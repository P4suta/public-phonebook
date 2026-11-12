---
date: 2026-11-12
---

# Keep iOS assurance local and distribution protected

## Status

Proposed.

## Context

TestFlight repeats expensive checks after local verification.
The maintainer requests local verification and a short CI release path.

## Decision

Run native tests, sanitizers, mutation testing, and proofs locally when their scope changes.
Review the source and applicable local results before approving distribution.
Use GitHub's [protected environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments) for approval.
CI runs fast checks, builds without credentials, and signs and uploads in separate protected jobs.
Preserve the original artifacts, attestations, build identity, and upload reconciliation.

## Alternatives

Hosted assurance supplies an independent runner but repeats the work.
Publishing local results as commit statuses adds another admission mechanism.
Both remain unnecessary for the maintainer's release process.

## Consequences

Release approval trusts the maintainer's review of local verification.
The manual Assurance workflow remains available for hosted diagnosis.
Reconsider when releases require independent hosted verification.

## Confirmation

Reject local distribution, dirty sources, another workflow, and changed artifacts.
Verify the workflow's approval and credential boundaries and complete a TestFlight delivery.
