---
date: 2026-10-30
---

# Authenticate the entire staging origin

## Status

Proposed.

## Context

Separate Workers, databases, and buckets isolate environments without authorizing readers.
The staging website, API, documentation, archives, and assets require one authorization boundary.
Production remains anonymously readable.

## Decision

Cloudflare Access protects the complete staging hostname with an explicit reviewer allowlist and a staging-only service identity.
The Worker runs before assets and independently verifies Access assertions with the pinned `jose` implementation.
It requires the configured issuer, application audience, signature, expiration, issue time, application token type, canonical origin, and permitted email or service identity.
Unknown settings and verification failures deny access before routing.
All staging responses prohibit shared caching.
Credentials are removed before application and asset dispatch.
Private R2 buckets have neither public managed domains nor custom domains.
Worker development hostnames and preview URLs remain disabled.

Browser requests include same-origin cookies only on staging.
Verification forwards service credentials from Node only to the exact staging origin without following redirects.
Browser routing receives response bytes without receiving the service headers or Access cookies.
Doppler stores the service secret only in the staging configuration.
The Worker receives public verification settings, never the service secret.

Hostname secrecy and CORS do not establish authorization.
Putting authentication inside the API router would leave HTML and assets exposed and break internal SSR reads.
Global browser authentication headers would expose credentials to traces and external requests.

## Consequences

The owner can review staging through the existing one-time PIN identity provider.
Automation has a finite credential lifetime and must stop when its identity expires.
Access policies and private storage configuration are checked before staging publication.
Cryptographic assertion tests, boundary tests, native asset tests, and live anonymous probes cover boundaries outside the pure admission proof.
Cloudflare's edge enforcement and identity provider remain external trust assumptions.
