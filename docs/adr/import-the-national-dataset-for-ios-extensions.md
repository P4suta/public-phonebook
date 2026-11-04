---
date: 2026-10-31
---

# Import the national dataset for iOS extensions

## Status

Accepted.
It supersedes the prefecture selection, the paged import, and the one-contact saves in [Share directory snapshots with iOS extensions](share-directory-snapshots-with-ios-extensions.md).
The App Group generations, the per-number projections, and the activation order of that record still apply.
Since #188, the first download starts from the start button and shows the steps of [Count the first download down toward a deadline that only moves earlier](count-the-first-download-down-toward-a-deadline-that-only-moves-earlier.md).
Monthly updates since then use only paths that are neither expensive nor constrained.
[Start from a bundled directory archive and catch up through deltas](start-from-a-bundled-directory-archive-and-catch-up-through-deltas.md) partly supersedes the first-run download and the monthly cadence.

## Context

Calls can come from a public facility in any prefecture, so a phone that stores only selected prefectures misses most identifications.
The paged import needed more than 60 contact requests for every prefecture and about 1,300 for Tokyo.
The zone rate limit blocks a client for 10 seconds after 60 contact requests in 10 seconds, and warm edge-cache pages reached that limit after 59 requests on 2026-10-31.
Each published snapshot lists immutable national files with their byte lengths and SHA-256 digests, outside the contact rate limit.
The 65 MB `contacts.jsonl.gz` file repeats identifiers, licenses, and source details in every record, and the app displays few of those fields.
Saving one contact into personal contacts needs a separate write path and changes the reader's own data.

## Decision

Download the national `directory.tsv.br` archive listed by `/api/v1/datasets` in one request.
The archive stores shared categories, municipalities, sources, provenance, and links once in its header and carries only the displayed fields in each row.
Accept it only when its byte length and SHA-256 digest match the listing and its header names the discovered snapshot.
Decode the Brotli stream incrementally, validate every row and the row order, and compare the per-prefecture counts with the header before activation.
Provide every stored record to caller identification.
Save the data in the first-run setup over Wi-Fi or cellular networks, show only the saved percentage, and update it about once a month without a setting.
Remove the prefecture selection, the system contact editor, and vCard sharing.

## Consequences

One request replaces thousands, and the import no longer depends on the contact rate limit.
The production snapshot of 667,696 contacts produced a 13.4 MB archive, about a fifth of the JSON Lines file.
Each update transfers the full archive until the snapshot deltas in #55 exist.
A cellular save uses that transfer from the reader's data plan, and the setup screen says that it saves the national data before it starts.
The device stores about 650,000 records.
The app no longer requests Contacts access.
