---
date: 2026-11-01
---

# Keep release records in a conditionally written control bucket

## Status

Proposed.
Amends [recover complete Worker and dataset publications](recover-complete-worker-and-dataset-publications.md), which kept the journal under `.local/releases`.

## Context

Publication journals, verification bundles, and receipts lived in one checkout's `.local` directory and recorded absolute paths.
A GitHub Actions runner couldn't read them, so a publication from CI would have no verified predecessor and no recovery record.
A file lock serialized publishers only on one machine.
The release workflow needs records that any runner can read, and it needs one publisher per environment across runners.
The cf CLI writes R2 objects without preconditions, so it can't arbitrate concurrent writers.

## Decision

Keep publication records in the private R2 bucket `dial-control` and reach it through the S3 API.
Use a small port with reads, create-only writes that send `If-None-Match: *`, and replacements that send `If-Match` with the stored entity tag.
R2 evaluates these conditions atomically with the write, so at most one concurrent writer succeeds and the others receive 412.
Sign requests with `aws4fetch` in the release tools only, and keep it out of the Worker bundle.
Read the account and credentials only from environment variables, and never print them.
Send the payload's SHA-256 as `x-amz-content-sha256` so the signature covers the uploaded bytes.

Name every key in one module, and refuse a replacement outside the conditional keys.
- `blobs/sha256/`, `datasets/<manifest>/`, `collections/<report>/`, `collection-cache/`, and `candidates/<tree>/<manifest>/` are written once.
- `journals/<env>/head.json` and `leases/<env>.json` are replaced conditionally.
- `journals/<env>/history/` and `evidence/` are append-only, and a bucket lock makes them permanent, which R2 reports as 409.

`<report>` is the digest of a collection report, which records the digest of each other collector output.
`collection-cache/` holds each source artifact by its own digest.

Store journals in format 2.
Format 2 drops the absolute `bundle` path, because the verification bundle lives under `datasets/<manifest>/` and its key is the manifest digest.
It adds the environment, a sequence number, and the run provenance.
The provenance names the repository, workflow, run ID, attempt, commit, and actor for Actions, or `local` for owner recovery.
A save replaces the head first and then appends the same bytes to the history under its sequence number.
A later save restores a history record that an interruption left out, because the head holds the same bytes.
Convert a format 1 journal only when its file name matches its release and its bundle directory name and manifest bytes match the recorded manifest digest.

Serialize publishers with a lease in `leases/<env>.json`.
The lease lasts 10 minutes, and its holder renews it every 60 seconds.
The expiry comes from the `Date` header of R2's response, so the decision never reads the local clock.
The pure decision `leaseAdmission` takes the presence, the holder, the server time, and the expiry as bounded integers.
It acquires an absent lease, renews only a live lease of the same holder, takes over only an expired lease of another holder, and reports an expired own lease as lost.
A holder that can't confirm a renewal within nine minutes stops before its next provider effect.

Admit candidate evidence per stage with the pure decision `evidenceAdmission`.
It refuses a missing stage, a record for another tree or manifest, a record from a signer other than the candidate workflow, and a failed stage, in that order.
Both decisions are Dafny contracts with negative controls in the proof gate.

`tools/control-import.ts` maps the owner's format 1 journals, verification bundles, retained datasets, and receipts to control objects.
It orders each environment's history by the predecessor chain and the file modification time, and it refuses a head that isn't the latest record.
`--plan` prints the objects and writes nothing.

## Consequences

Any runner with the control credentials can read the verified predecessor, recover a publication, and serialize with other runners.
The local `.local/releases` directory is no longer a recovery source after the owner imports it.
Publication now depends on R2 availability and on the control credentials, and an R2 outage stops publication rather than risking two writers.
A lost response to a conditional write is resolved by reading the object back and comparing its bytes.
A single PUT carries each blob, which bounds an object at 5 GB.
The owner's retained databases are about 1 GB each.
The file-system store enforces the same preconditions for tests, but only within one process.
The decisions are proven for all admitted inputs, while R2's atomic conditions and response time remain external trust assumptions.
Rejected alternatives were a Durable Object coordinator, which would add a Worker that only the release tools use, and GitHub's `concurrency` alone, which doesn't serialize the owner's local recovery.
