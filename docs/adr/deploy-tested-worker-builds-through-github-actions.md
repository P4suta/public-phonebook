---
date: 2026-11-10
---

# Deploy tested worker builds through GitHub Actions

## Status

Proposed.
It replaces the deployment coordination in [independent delivery operations](select-delivery-operations-independently-from-required-checks.md).

## Context

Worker publication accumulated project-specific plans, remote journals, and cross-platform check records.
A successful deployment can still fail while publishing an unrelated GitHub release record.

## Decision

Adopt Cloudflare's [GitHub Actions pattern](https://developers.cloudflare.com/cf/ci/): build with the pinned `cf` CLI, validate without credentials, and deploy the tested output with `cf deploy --prebuilt`.
Use GitHub [job dependencies, environments, artifacts, and concurrency](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments) for publication control.
Fetch scoped Doppler credentials through the existing environment-bound OIDC identities.
Keep immutable dataset bindings and the provider's Worker version history for recovery.

Keep dataset publication and native store workflows independent.
Require verification for their affected contracts without requiring unrelated platform campaigns for a website deployment.

## Alternatives

Workers Builds provides managed Git integration, but GitHub Actions already hosts the required data and native workflows.
Keeping the custom controller preserves its recovery behavior at high maintenance cost.

## Consequences

Provider deployment state replaces the custom publication journal.
Historical records remain retained.
Reconsider managed builds if GitHub runner maintenance becomes the dominant cost.

## Confirmation

Exercise secret-free pull-request validation, protected publication, public response checks, and Cloudflare rollback before retiring the previous publisher.
