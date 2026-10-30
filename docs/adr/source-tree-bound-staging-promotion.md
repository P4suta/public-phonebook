---
date: 2026-10-30
---

# Bind production promotion to checked staging source and data

## Status

Proposed.
Implemented as the publication gate.
This extends the deployment boundary in [native Cloudflare services](native-cloudflare-typescript-services.md).

## Context

Local tests do not establish provider limits, remote bindings, domain routing, or HTTPS behavior.
A database copy and its complete archives must be ready before a candidate serves the public directory.
Staging and production need separate resources and a reproducible candidate identity.
An interrupted import must not replace an unrelated publication or repeat committed inserts.

## Decision

Use the pinned cf CLI for resource provisioning, bound D1 batches, R2 uploads, and prebuilt Worker deployment.
Keep account selection in Doppler and use the existing provider authentication profile.
Bind remote imports to the validated SQLite digest and store progress with each atomic D1 batch.
Refuse unowned databases and mismatched import identities.
Keep original publications and the previous public Worker intact.

Require a clean committed checkout for publication.
Bind the staging receipt to its Git tree, source commit, snapshot, configured HTTPS origin, build hashes, and successful public checks.
Require the same tree and snapshot before production promotion.
Use tree identity for file equivalence across merge commits while recording the commit identity separately.
Keep environment-specific builds and bindings distinct.

Check actual annotated import and promotion decisions through LemmaScript and Dafny.
Use native D1 interruption and rollback tests for transaction semantics outside the verifier.
Use public browser, API, and complete-download checks for provider and network boundaries.
The deployment procedures and evidence paths are defined in [deployment](../deployment.md).

## Consequences

Source changes or a different snapshot invalidate staging evidence for production.
Content-addressed archives and the original SQLite input remain available for reconciliation.
Imports can resume after a lost response without treating a failed request as an uncommitted batch.
An update to a different publication needs separate resource preparation rather than an in-place destructive reset.
The generated cf surface currently exposes query batches rather than the bulk-import workflow, so initial import performs multiple authenticated requests.

Deploying directly to production would leave provider behavior unchecked before cutover.
Mutable shared databases would couple staging failures to production data.
Commit-only identity would reject a file-identical merge for historical rather than behavioral differences.
The proof establishes decision predicates under their input assumptions, not Cloudflare transactions, HTTPS delivery, or the truth of source data.
