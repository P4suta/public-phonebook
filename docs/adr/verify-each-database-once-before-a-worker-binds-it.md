---
date: 2026-11-04
---

# Verify each D1 database once before a Worker binds it

## Status

Proposed.
It amends [verify release candidates in place before approval](verify-release-candidates-in-place-before-approval.md), whose candidates no longer always get a new D1 database.
It amends [keep release records in a conditionally written control bucket](keep-release-records-in-a-conditionally-written-control-bucket.md) with database evidence under `evidence/`.

## Context

A production database's name derives from its database SHA-256, so a release of the dataset that production serves reuses production's own D1 database.
A release that repeats the dataset of a candidate waiting at 0% reuses that candidate's database too.
Preparation used to verify every database with full-table reads after its import.
It counted rows and distinct values, ran `PRAGMA foreign_key_check`, and compared fixed records and the catalog with the validated source.

D1 runs one query at a time for each database and refuses work past a 10-second resource window.
On 2026-11-04, release run 41754147605 verified production's database this way while it served traffic.
Better Stack saw `GET /api/v1` answer 503 at 02:07:16Z and `GET /` answer 500 at 02:07:20Z, and every check passed again by 02:09:27Z.
Run 41748393069 had failed on the overload error in the same step, and the retry that followed it kept a bound database under pressure for longer.

## Decision

Scan a database in full only while no Worker version binds it, and record the passing result once.

Before preparation reads the database, it reads two facts from the control store under the publication lease.
- The journal head names the databases whose versions the deployment may hold: the candidate after `verified`, the predecessor after `withdrawn` or `recovered`, and both in every other phase.
  A target that shares the database's digest or its D1 ID binds it.
- `evidence/databases/DIGEST/ID.json` holds the evidence of an earlier full verification of exactly that digest and D1 database.

Preparation then reads the import identity and the stage checkpoints, which are a few rows, and calls `databaseVerification` in `src/core/publication-policy.ts`.
- Evidence that names another digest or D1 ID is refused.
- Matching evidence is accepted when every checkpoint has reached its source count, and an incomplete database is refused.
- Without evidence, an unbound database receives the rest of its import and the full verification.
- Without evidence, a bound database is accepted only when it is complete and the journal shows that the release tools staged exactly this database by digest.
  Every other bound database is refused.

A passing full verification writes evidence with the counts and the run provenance.
An accepted publication writes evidence that cites the journal sequence and the release ID.
An accepted database receives only the identity and checkpoint reads and four reads by primary key: the catalog row and three fixed contacts.
It receives no count, foreign key check, or write.
D1's overload error repeats a read-only batch only for an unbound database, and a bound database fails on the first overload.

Dafny proves `databaseVerification` for all inputs, including that a full verification never targets a bound database.
One proof control lets a bound database reach the full verification, and another accepts evidence for another digest; both must fail.

### Publication as evidence

The served database was verified before evidence existed, so the journal stands in for its evidence.
The release tools record a target bound by digest only in `tools/publish.ts`, and `stageCandidate` leaves `preparing` only after its `prepare` port passes.
That port requires `.local/remote-data/production.json` with `result: "verified"` for exactly that database ID, name, and digest.
Since the native services migration, preparation has written that file only after the full verification passed.
After an import completes, the import writes nothing and the Worker only reads, so that verification still describes the database.
The journal head changes only under the lease that preparation holds, and the bucket lock keeps its history.
The adopted baseline is bound by snapshot and never passed this repository's import verification, so it doesn't count.

Release run 41607870633 staged and promoted the database of manifest `021f5435c7c8b2df143da1616ea65225284e61c512d428841887527eb4e0a8d6` on 2026-11-03.
The next preparation of that dataset accepts that publication and records it as evidence.

## Consequences

A release of the served dataset or the waiting candidate's dataset sends that database a few small reads instead of full scans.
A fresh database still receives the full verification once, before any version binds it.
A verification that an outage interrupts runs again in the next preparation, because no version binds that database yet.
The owner decides about a bound database that has no evidence and no digest-bound publication, such as the adopted baseline.
Evidence stays permanent under the bucket lock, and a recreated D1 database has a new ID and gets its own evidence.

The rule assumes that no deployment outside the release tools binds a database that the journal doesn't name.
It assumes that the journal's publications came from the tools described here, and that nothing writes a database after its import.
Preparation no longer detects provider corruption of a reused database after its first verification.
The public checks still read it through the candidate, and the complete archives keep their digests.
Only a live release shows whether a reused database stays free of overload.

Rejected alternatives:
- Verifying a fresh copy would collide with the digest-derived name, repeat a complete import, and still leave the bound database unchecked.
- Throttling the full verification would still compete with live queries in a database that runs one query at a time.
- Accepting every complete database without evidence would also accept a bound database that never passed verification.
