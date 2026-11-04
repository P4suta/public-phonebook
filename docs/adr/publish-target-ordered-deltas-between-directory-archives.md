---
date: 2026-11-02
---

# Publish target-ordered deltas between directory archives

## Status

Accepted.
The server publishes, lists, and checks deltas.
The iPhone app applies them since #95, and downloads the complete archive after any delta failure.
[Start from a bundled directory archive and catch up through deltas](start-from-a-bundled-directory-archive-and-catch-up-through-deltas.md) partly supersedes the retention rule with deltas from every shipped snapshot.

## Context

The iPhone app saves the national `directory.tsv.br`, about 13.4 MB, and downloads it again for each monthly snapshot.
Most rows don't change between snapshots, so a delta from the saved archive could transfer far less.
Archive rows carry no contact identifier, and identical rows may repeat, so a delta can't name a record to replace or update.
Rows refer to the header's category, provenance, and link dictionaries by index.
One new link or source that sorts early renumbers every later row that refers to its dictionary.
A category that gains its first contact renumbers the first field, which also reorders the archive.
A provenance includes the retrieval time, so a recollection changes the provenance of every row from each refreshed source.
A line-by-line difference would then repeat most of the archive each month.
The app stores rows by archive position, so it can read any range of its saved rows without a sort.

## Decision

Publish `directory-delta-{base}.tsv.br` format 1 from each retained earlier snapshot to the new snapshot, as `docs/api.md` specifies.
Carry maps from each base category, provenance, and link index to a target index in the delta header.
Carry the target header line byte for byte, and follow it with instructions in target row order.
An instruction copies a range of base rows through the maps, or adds one literal row.
Leave removed rows implicit, so the delta never repeats their text.
Map categories by ID and links by URL.
Map each base provenance to the target provenance that the most rows match once the provenance field is ignored, with ties going to the lower index.
Record the decoded length, SHA-256, and row count of both archives, and admit a rebuilt archive only when all three match the target.
Generate deltas while preparing a snapshot, apply each one to its base, and require the exact target bytes before recording it.
Publish a delta only when its Brotli bytes are at most half of the complete archive's.
A client that loses a delta then downloads at most one and a half complete archives, and a client that uses one saves at least half.
Below that saving, the extra path isn't worth its failure mode, because the client rewrites its whole store either way.
Keep at most 12 deltas, a year of monthly snapshots.
List them at `/api/dataset-deltas` and the pinned `/api/v1/dataset-deltas`, and keep `/api/datasets` and `/api/v1/datasets` unchanged.
Prove the copy range guard, the size rule, and the admission decision in Dafny.

## Consequences

The production snapshot of 667,696 contacts was prepared from the 650,933-contact base, with a canonical copy of that base as its delta base.
Its delta took 374,905 bytes, 2.8 percent of the 13,428,507-byte archive.
Every base row stayed a copy, although the maps renumbered 719 of 720 provenances, 879 of 883 links, and 20 categories.
A row-by-row difference of the same pair repeated every row and took 26,499,639 bytes, about twice the complete archive.
Applying that delta in Node took 0.7 seconds, and the data check passed on the prepared bundle.
A client applies a delta while it streams the instructions, hashes the rebuilt archive as it writes it, and needs no local sort.
A recollection that only changes retrieval times costs one map entry per provenance instead of every row.
A bad provenance choice can only add literal rows, because the target digest decides whether a delta is right.
The data check can't read copied rows without the base, so preparation's own application stays the only check of copied content.
The ready manifest lists the deltas, so the dataset digest covers them, and old manifests without deltas still parse.
The hosted release can't produce deltas until `release.yml` fetches the retained bundles before preparation.
The discovery documents link the listing as `datasetDeltas`, and the shared contract corpus holds a fixture delta that both appliers rebuild exactly.
The app doesn't keep the decoded digest of its saved archive, so a base whose rows differ only fails at the target digest.
Lean proves the app's admission order and copy range guard, bound to the exact Swift source.
