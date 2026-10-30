---
date: 2026-10-29
---

# Serve immutable Rust snapshots through Cloudflare Workers and Containers

## Status

Accepted for production.
The local implementation is superseded by [native Cloudflare TypeScript services](native-cloudflare-typescript-services.md).
The production deployment remains unchanged by that local work.
The local service path is built and checked.
This extends [the SQLite snapshot decision](sqlite-national-snapshots.md).

## Context

National searches and portable downloads must preserve contact identity, provenance, and complete result sets.
The Rust core already defines the telephone, municipality, pagination, and export contracts.
A second database adapter would create another implementation of these contracts.
The current SQLite file is approximately 828 MB, and browsers must never download it to search.

## Decision

Use the Cloudflare `cf` CLI, Cloudflare Vite Plugin, and typed `cloudflare.config.ts`.
Pin the beta CLI and plugin versions in the package lockfile.
Keep the verified Rust core and SQLite implementation in a Cloudflare Container.
Serve static assets through the Worker asset binding.
Use one fixed Durable Object name and one initial container instance.
This is an explicit capacity ceiling, not a throughput claim.
Use the native Durable Object Container API with the supported Durable Object scheduling policy.
Resolve the current Worker's class through its typed `ctx.exports` loopback namespace.
Select a named digest-pinned image and the `standard-1` instance size at startup.
Keep the resource profile in Container labels so an unchanged image still restarts when its requested resources change.
Share startup readiness across concurrent requests, replace an obsolete image or profile, and restore the native ten-minute inactivity timeout after object reconstruction.
The fixed name enforces the service's instance bound because this policy has no application-wide maximum.

Prepare service bundles only after the national audit verifies the database and archived source hashes.
Include the database, a snapshot manifest, and its lease file.
Exclude raw archives from the runtime image.
Require the manifest at container startup and verify the exact database SHA-256 before binding the port.
Treat a bundle as immutable while serving it.
Build a replacement image to change data instead of importing data inside the public service.

Keep database work outside the async executor.
Limit concurrent searches and exports, refuse excess work with a recovery response, and stream exports through bounded buffers.
Hold export capacity until both the producer and response body release it.
Cancel production when the reader disconnects.
Commit download headers only after database preparation succeeds.

Use private checked constructors and exhaustive domain variants for regions and export formats.
Keep raw URL fields at the HTTP boundary.
Use a validated TypeScript feed page and a discriminated state union for loading, recovery, completion, and page suspension.
Compile the browser source to the embedded JavaScript artifact and reject output drift.

Forward only the headers needed for content negotiation and asset validation.
Do not forward cookies, authorization, client IP headers, or client-supplied request IDs.
Log route patterns, result status, elapsed time, generated request IDs, and the snapshot hash.
Do not log query strings or record payloads.
Disable Worker invocation logs and redact query strings in platform observability.
Disable container internet access and SSH in the application configuration.
Keep the database and manifest owned by root and read-only, with a non-root app user.

## Consequences

The public service and local Rust server share the same database semantics and pure decision core.
Image and manifest identities support reproducible startup and rollback.
Container startup, image distribution, and a single-instance capacity ceiling add operational costs.
Cloudflare billing, global placement, production traffic, and production capability behavior remain deployment boundaries.
The local Cloudflare development runtime requests Docker capabilities for its own networking adapter.
A non-root image alone does not establish isolation on Cloudflare's production platform.
The Durable Object scheduling policy grants root capabilities to processes regardless of their user ID.
The HTTP interface exposes no process execution operation, and the Rust adapter opens its prepared database read-only.

Moving all queries to D1 would require another adapter and a large-data import and export design.
Shipping all records to each browser would increase transfer and parsing work for every visitor.
Native address-book synchronization would add device permissions, account state, background execution, and conflict handling.
These alternatives do not improve the current search and download contract.

The CLI, config format, and Vite plugin are beta interfaces.
Dependency changes must pass type checks, local Worker and Container tests, and a deployment dry run.
See [deployment commands](../deployment.md) and [verification boundaries](../verification.md).

## References

- [Cloudflare project commands](https://developers.cloudflare.com/cf/projects/)
- [Typed Cloudflare configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
- [Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Container scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
- [Worker loopback bindings](https://developers.cloudflare.com/workers/runtime-apis/context/#exports)
- [Local Container development](https://developers.cloudflare.com/containers/guides/local-dev/)
