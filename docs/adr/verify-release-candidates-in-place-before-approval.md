---
date: 2026-11-02
---

# Verify release candidates in place before approval

## Status

Proposed.
It supersedes [authenticate the entire staging origin](authenticate-the-entire-staging-origin.md) and [bind production promotion to checked staging source and data](source-tree-bound-staging-promotion.md).
It amends [recover complete Worker and dataset publications](recover-complete-worker-and-dataset-publications.md).
[Verify each D1 database once before a Worker binds it](verify-each-database-once-before-a-worker-binds-it.md) amends this record.
A candidate of a dataset that production already serves shares the current version's database, and preparation reads that database only by primary key.

## Context

The staging environment had its own Worker, D1 imports, bucket, Cloudflare Access application, and a service token that expired after 90 days.
Its checks ran on another Worker with other bindings, so they didn't establish how the production Worker would behave.
Production was then rebuilt and deployed, so the owner approved one build and the public received another.
Each snapshot needed two imports, and the token needed manual rotation.
The production Worker also carried the Access code and its configuration.

Cloudflare can deploy a Worker version at 0% beside the current version.
A request with the `Cloudflare-Workers-Version-Overrides` header reaches that version, and every other request keeps reaching the current one.
When an override doesn't apply, Cloudflare silently answers with the current version.

## Decision

Verify each release candidate inside `dial-production` and move traffic only after the owner approves it.

1. Prepare the candidate's data under its content digests in a new D1 database and new R2 keys, which the current version never reads.
2. Upload the candidate with `cf workers versions create`, tagged with its release ID, and deploy it at 0% beside the current version.
3. Run the public checks on `www.dial.page` with the override header aimed at the candidate.
4. Wait for the owner's approval of the GitHub `production` environment.
5. Move traffic from 0% to 100% in one step and run the public checks again without the override.
   A failure restores the preceding version and its data, which stay deployed and retained.

The journal records the phases `preparing`, `staged`, and `candidate-verified`.
A failure before approval records `withdrawing` and then `withdrawn`, and the current version and the verified predecessor stay unchanged.
After approval, the existing activation records `activating`, `checking`, and `verified`, or `recovering` and `recovered`.

Six conditions keep the approved version and the public version the same.
- Every response carries `x-dial-version` from `CF_VERSION_METADATA`, and every check refuses a response from any other version.
  The checks wait for three consecutive candidate answers before they start.
- The Worker keeps `runWorkerFirst: true`, so assets come from the candidate too.
- The tools refuse a candidate that changes domains, routes, cron triggers, Worker-first routing, `workers.dev`, or preview URLs.
  A 0% version can't apply or check those Worker-wide settings, so the owner applies them separately with `cf`.
- Traffic moves from 0% to 100% at once.
  An intermediate split could serve a page and its assets from different versions, and pinning them would need a cookie that the privacy page rules out.
- The checks count their requests in a sliding 10-second window and hold any request that would be the 40th.
  The zone's rate limit blocks a client after 60 requests in 10 seconds.
- A candidate awaiting approval blocks every new deployment, and its version ID stays masked in logs.
  The owner can withdraw it with `just withdraw production`.

Pure decisions in `src/core/publication-policy.ts` gate the transitions, and Dafny proves each one.
`promotionAdmission` admits only a verified candidate whose version ID is still deployed at 0% while the current version is still the verified predecessor.
`withdrawalDecision` removes only the candidate this release owns, and only while the predecessor serves and no traffic has moved.
The pre-existing `leaseAdmission` serializes publishers.

The release workflow calls separate entry points for each job.
`--stage` uploads and deploys the candidate, `--verify-candidate` checks it with a read-only token, and `--promote --release ID` moves traffic after approval.
`--withdraw` and `--recover` stay available to the owner.
`--drill` stages a candidate, injects a probe failure after its checks, and requires the withdrawal to leave the serving version and the journal's predecessor unchanged.

GitHub's environment approval expires after 30 days.
The tools record no approval deadline of their own, because promotion already requires the candidate to remain deployed at 0% and the current version to remain unchanged.

## Consequences

The version that the owner approves is the version that takes traffic.
Each snapshot needs one D1 import, no service token needs rotation, and the production build needs no secret.
The Worker no longer contains Access code or the `jose` dependency.

The job that stages a candidate holds a token that can also deploy, because Workers can't separate uploading from deploying.
That job only creates a version from the attested build and deploys it at 0%, and a read-only token runs the checks.
Anyone who knows a candidate's version ID can reach it while it waits, which the masked logs make harder but don't prevent.
The service only reads public data today, and a future feature that writes or keeps state needs a new isolation decision.

The provider's Worker and version responses, the override header, and the rate limit are external trust boundaries.
Fake providers in the unit tests cover staging, withdrawal, promotion, rollback, and the drill through the same lifecycle code.
The first real drill runs from the release workflow before the first approved publication.
The staging Worker, its database, bucket, Access application, token, and Doppler configuration stay in the account until the owner removes them after that publication.

Rejected alternatives were keeping staging and renewing its token, either automatically or by hand.
Both keep the checked build apart from the published build.
