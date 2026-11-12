---
date: 2026-11-12
---

# Keep iOS assurance local and distribution protected

## Status

Accepted.
The owner selected local assurance and protected CI distribution.

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

Source and artifact checks reject local distribution, dirty sources, another workflow, and changed artifacts.
[Run 43196789927](https://github.com/P4suta/public-phonebook/actions/runs/43196789927) completed the protected build, signing, and upload jobs for 1.1.0, build 2001.
The build reached `VALID`, and the owner installed the TestFlight update and confirmed the main tasks on iPhone.
