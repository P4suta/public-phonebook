---
date: 2026-11-01
---

# Publish a name-ordered search index for the website

## Status

Accepted.
The website searches this index in the browser, as [the browser search decision](search-in-the-browser-once-the-index-loads.md) records.

## Context

The website sends each search to the server, and Japanese input still sends a request after each conversion or deletion.
Searching in the browser needs the names, categories, regions, and telephone numbers of every contact for each snapshot.
The complete `directory.tsv.br` carries addresses, provenance, and links that result cards don't show, and it doesn't carry normalized names.
Result cards show telephone numbers, so fetching them per search would tell the server which results a reader is viewing.
The server breaks rank ties by the normalized name and then the identifier, while D1 row numbers followed the identifier alone.
Browser results need the same order as the server so that results with and without JavaScript match.
A browser result also needs a row position that maps to a D1 row without sending identifiers to the browser.

## Decision

Number D1 rows in the order of the normalized name's UTF-8 bytes and then the identifier, so each row number is the row position plus one.
Keep the JSONL, CSV, and vCard downloads, `directory.tsv.br`, and the snapshot digest in identifier order.
Publish `search-index.br` format 1 for each snapshot, built from the prepared database in row order.
Start the file with the line `public-phonebook-search-index`, a tab, and `1`, followed by one line of header JSON.
Put the snapshot, the row count, the categories, the prefectures, the municipalities, the used region codes, and the byte length of each part in the header.
Follow the header with four parts and no separators between them.
- The name part has one line per row with the normalized name, followed by a tab and the display name only when they differ.
- The category part has one byte per row, which indexes the header's categories.
- The region part has two little-endian bytes per row, which index the header's ascending region codes.
- The telephone part has one line per row with the national numbers separated by spaces.

Reject tabs, line breaks, and lone surrogates in names, names that aren't the normalized form of the display name, and rows out of name order.
Compress the index with Brotli and store it under its snapshot and the digest of its compressed bytes.
Record the compressed and uncompressed sizes and digests in the prepared manifest, and keep the index out of the public `/api/datasets` listing.
Rebuild the index in the data check, compare its bytes, check the row order in SQL, and reject a compressed index above 8 MiB.

## Consequences

The production snapshot of 667,696 contacts produced an index of 7,246,869 bytes from 41,067,471 bytes, which is 6.9 MiB and below the cap.
Compressed one at a time, the names took 3.85 MB, the telephone numbers 2.43 MB, the regions 0.75 MB, the categories 0.15 MB, and the header 16 KB.
About 28 percent of the rows carry a display name that differs from the normalized name.
The same snapshot kept its digest, and its JSONL, CSV, and vCard downloads stayed byte-identical.
Browser search can run without sending search terms, and it keeps working offline once the index is in the HTTP cache.
Row positions in the index match D1 row numbers, so a later row locator can find a contact without identifiers in the browser.
Preparation reads the source twice and inserts rows out of row-number order, which takes longer.
The index format is a website contract with its own version line, not a public download, so a later format can change it without an API version.
If a future snapshot exceeds the cap, the fallback is an index of display names that the browser normalizes and verifies.
