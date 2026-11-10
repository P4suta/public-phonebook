---
date: 2026-11-10
---

# Deploy tested worker builds through GitHub Actions

## Status

Proposed.
It replaces the deployment coordination in [independent delivery operations](select-delivery-operations-independently-from-required-checks.md).

## Context

Project-specific coordination couples Worker publication to unrelated release operations.
Custom Domain reconciliation also exceeds the existing per-Worker token's authority.

## Decision

Use Cloudflare's [CI pattern](https://developers.cloudflare.com/cf/ci/) to build once, validate without credentials, and run `cf deploy --prebuilt`.
Use GitHub [jobs, environments, artifacts, and concurrency](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments), scoped Doppler credentials, immutable dataset bindings, and Worker version history.
Keep existing Custom Domain connections in Cloudflare and omit domain changes from builds.
[Custom Domains lack per-Worker role support](https://developers.cloudflare.com/workers/authorization/workers/#routes-and-custom-domains).

Keep dataset and native publication independent, with checks for their affected contracts.

## Alternatives

Workers Builds centralizes Git integration, but Actions already hosts the required workflows.
Declaring domains with each deployment centralizes routing but requires broader credentials.
The custom controller preserves recovery behavior at high maintenance cost.

## Consequences

Domain setup stays outside app deployment.
Historical records remain available.
Reconsider declared domains when Cloudflare supports per-Worker domain authority.

## Confirmation

Exercise secret-free validation, protected publication, public responses, preserved domain routing, and rollback.
