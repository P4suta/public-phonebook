---
date: 2026-11-04
---

# Declare dataset file formats instead of API versions

## Status

Accepted.
This supersedes the part of [serving the directory JSON to the site only](serve-directory-json-to-the-site-only.md) that kept the `/api/v1` index, the version header, and the versioned listings.

## Context

The open-data routes list the complete dataset files and their deltas and serve those files.
After the route split, `/api/v1/datasets` and `/api/v1/dataset-deltas` repeated `/api/datasets` and `/api/dataset-deltas` under a second prefix.
The `/api/v1` index carried `version: "1"`, and every open-data response carried `X-Directory-API-Version: 1`.
That version gave a client nothing that the unversioned listings lacked.
It described the listing routes, but a client depends on the bytes inside each file.
The two native files already name their versions in their first lines: `public-phonebook-directory` or `public-phonebook-directory-delta`, a tab, and `1`.
The iPhone app has no public release yet, so only the owner's QA build reads the versioned routes.

## Decision

Serve one dataset listing at `/api/datasets` and the delta listing at `/api/dataset-deltas`, with no version in any path.
The dataset listing keeps the snapshot, `generatedAt`, the counts, and the digests.
It adds `datasetDeltas`, a link to the delta listing that pins the same snapshot with `?snapshot=`.
Both listings keep `X-Dataset-Snapshot` and accept an optional `?snapshot=` pin, which returns 409 after a change.

Each file entry and each delta entry declares `format`.
A format is an identifier, a slash, and the version of the file's bytes as served, compression included.

| File | Format |
| --- | --- |
| `contacts.jsonl.gz` | `public-phonebook-contacts-jsonl/1` |
| `contacts.csv.gz` | `public-phonebook-contacts-csv/1` |
| `contacts.vcf.gz` | `public-phonebook-contacts-vcard/1` |
| `directory.tsv.br` | `public-phonebook-directory/1` |
| `directory-delta-{base}.tsv.br` | `public-phonebook-directory-delta/1` |

Each identifier names the persisted format instead of a route or a release.
For a file with a magic first line, the identifier is that line with a slash in place of the tab.
The code derives the identifier from that line, so the two can't drift apart.
The three gzip exports have no magic line, so their identifiers join the same project prefix, the content, and the serialization.
The vCard identifier names the project's gzip packaging of vCard 3.0 cards, which no standard defines.

A format change ships as a new entry with a new identifier beside the old one.
The listing keeps the old entry until its clients have moved, and an identifier never changes meaning.

File URLs stay content-addressed and immutable at `/api/datasets/{snapshot}/{sha256}/{file}`.
Remove the `/api/v1` index, the versioned listings and file URLs, the `version` field, and `X-Directory-API-Version`, with no compatibility path.

The iPhone app reads `/api/datasets`, decodes only the entries in its formats, and skips the rest unread.
Without an archive in its format, it reports `ServiceError.unsupportedFormat` and asks the reader to update the app.
It skips deltas in other formats and downloads the complete archive when no delta in its format starts from the saved snapshot.

## Consequences

One listing describes the open data, and the data page and the app read the same document.
A client chooses files by what it can read, so a new format reaches new clients without breaking old ones.
An old app that finds only newer formats shows a clear message instead of a decoding failure.
The owner's installed QA build reads the removed routes, so it stops updating until it gets a build from this change.
The uptime check for app data requires `public-phonebook-directory/1` in the listing, so it fails when the listing drops the app's archive.
Rejected alternatives were keeping `/api/v1` beside the unversioned listings, which kept two copies, and a new API version per format change, which would version unchanged routes.
