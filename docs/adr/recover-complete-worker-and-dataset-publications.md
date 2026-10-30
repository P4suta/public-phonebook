---
date: 2026-10-30
---

# Recover complete Worker and dataset publications

## Status

Proposed.
Extends [source-bound staging promotion](source-tree-bound-staging-promotion.md).

## Context

A successful deployment can still fail website, API, or download verification.
Restoring application code without its D1 and manifest bindings can expose a mixed publication.
Interrupted commands need an inspectable checkpoint and must not overwrite another publisher's active version.

## Decision

Prepare immutable D1 resources and content-addressed R2 archives before activating a candidate.
Bind the Worker version to the complete manifest SHA-256 as well as the database resource.
Record the verified predecessor, candidate identity, source tree, build digest, data digests, and phase before each provider effect.
Keep the authoritative journal under `.local/releases` with atomic replacement and a heartbeat lease shared across checkouts.
Serialize local builds separately so a concurrent build cannot replace the candidate's prebuilt output.
Keep source edits and independent provider deployments outside a running publication.

Require current source-bound full-test and proof receipts.
Check populated coverage in all 47 prefectures before activation.
Production must preserve each preceding populated category and at least 90 percent of its contact count.
This threshold is an operating policy for detecting incomplete imports, not a statistical quality guarantee.
A legitimate larger reduction requires a reviewed policy change rather than a command-line bypass.
Production promotion requires the identical source tree, contact snapshot, database digest, and manifest digest actively verified in staging.

After any ordinary publication failure, restore the complete preceding Worker version through Cloudflare's deployment API.
Verify its bindings, website, API, and complete archives again before recording recovery.
Restore only when the active version belongs to the interrupted candidate or already equals the verified predecessor.
An unknown active deployment, failed recovery, or lost checkpoint remains pending and blocks another publication.
Recovery needs no clean checkout, build, or proof campaign.

The initial staging bootstrap has no verified predecessor and therefore cannot promise rollback.
Require an explicit bootstrap action after Access protection is configured.
An owned active initial candidate can resume verification after interruption.
A new bootstrap from corrected source can supersede an owned initial candidate that failed verification, because no verified rollback target exists to protect.
Adopt the existing public production baseline only after checking its retained bundle and actual provider bindings.
Record unknown historical source and build identities as null instead of inventing verification evidence.

Retention computes a read-only plan.
It protects active databases, current rollback targets, and candidates referenced by pending journals.
It refuses foreign active versions and conflicting resource ownership.
It keeps all published R2 archive URLs and manifests.
No cleanup command deletes resources.

## Consequences

A single publisher uses local development, authenticated staging, and anonymous production without maintaining a separate development service.
`just release` performs the full local gate and promotes through both remote environments.
`just release-rehearse` verifies a real staging dataset A, deliberately rejects B after verification, confirms A's restoration, then publishes B normally.
It never injects faults into production.
The journals and preserved verification bundles must survive for supported recovery.
Losing local release state requires operator reconciliation rather than automatic adoption of an unknown deployment.

The source-bound proofs cover admission, promotion identity, coverage retention, recovery ownership, and resource protection decisions.
Fault-injected state-machine tests cover orchestration and retry behavior.
Native provider exercises and HTTPS checks cover Cloudflare and network behavior outside the verifier.
None establishes provider availability, telephone reachability, or the truth of an upstream record.

In-place database replacement would couple failure and rollback resources.
Code-only rollback would leave changed data bindings active.
Automatic deletion would risk breaking rollback targets and published download URLs.
