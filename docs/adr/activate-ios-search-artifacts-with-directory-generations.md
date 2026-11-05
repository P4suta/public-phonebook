---
date: 2026-11-05
---

# Activate iOS search artifacts with directory generations

## Status

Accepted in #308.
The implementation follows the accepted snapshot, ranking, and bundled-archive contracts.

## Context

The name index and ranking companion use name order, while the app stores contacts in directory-archive order.
Search must return the saved contact that belongs to each ranked row.
A directory update may arrive as a delta, and an interrupted update must preserve the current search and caller names.
The QA build must work with its bundled national dataset before the production service publishes search companions.

## Decision

Keep the verified national Brotli pair under `ios/SearchData` with a declaration of its compressed and decoded identities.
The generator requires the declaration to match the bundled archive's snapshot and contact count.
It admits both artifacts with PhonebookKit and copies the admitted pair and `search.json` into the app.
The production and verification configurations use the national pair.
Development and UI scenarios use companion artifacts generated from the provider corpus.
The extension carries no search files and continues reading its caller file.

For another snapshot, discover both companions and require their snapshot to match the directory listing.
Fetch their raw `/download` paths through the existing length-limited, hash-checked transfer implementation.
The raw paths omit `Content-Encoding`, which the existing transfer adapter rejects.
Their bytes preserve the compressed artifact identity, while the ordinary browser paths keep their HTTP Brotli contract.
Keep each search transfer in its own directory beside the archive transfers.
The archive downloader removes unrelated partial files, so sharing its directory would delete a companion during the next transfer.
Keep at most one partial identity for each companion and remove completed search transfers after activation.
The first-run size notice includes companions that the run needs to receive.

Before activation, admit both compressed and decoded identities, formats, counts, and posting bounds.
Map every name-index row to one staged archive record using the original display-name bytes, category, region, and canonical telephone numbers.
Consume each saved record once and reject any missing or remaining record.
Records with identical search fields remain distinct and map in archive order.
The published artifacts contain no address or provenance identity, so they can't distinguish those identical search fields by source.
Persist the mapping as little-endian UInt32 identifiers and bind its SHA-256 in the saved search declaration.
Require a complete permutation of the generation's identifiers when opening the mapping.

Synchronize the search files before replacing the active manifest.
The manifest's optional `rankedSearch` field distinguishes generations prepared with the pair while preserving readable storage format 4 generations.
Keep the active generation and its predecessor, including their search files.
The existing publication state machine protects uncertain activation, and `abort` removes search files only with a known inactive draft.
An existing installation gains search through a replacement generation rebuilt from its own saved archive rows.
A failed migration keeps its saved generation and retries on a later launch.
Automatic migration and updates keep the inexpensive-path restriction.

Each artifact remains bounded by its declared compressed and decoded lengths.
The compressed limits are 8 MiB for the name index and 64 MiB for the ranking companion.
The decoder caps each decoded artifact at 256 MiB.
The 2,000,000-contact limit bounds the mapping at 8,000,000 bytes.
The current pair adds 25,989,318 compressed bytes, plus 2,670,784 mapping bytes, to each national generation.
Retention can keep two complete generations and a staging generation during an update.
Decoding and scorer construction also need working memory beyond the retained files.

## Consequences

The QA build searches without new production files and can keep the previous search across a failed complete or delta update.
Changing the bundled national dataset requires changing its search declaration and pair in the same reviewed change.
Committing the pair adds about 26 MB to the repository and app resources.
Deriving morphology on the phone would require the full analyzer dictionary and would change startup and parity assumptions.
Waiting for a production publication would prevent the required independent QA build.
Keeping one global mutable index could expose mixed snapshots, so search files follow the generation lifecycle.

`just ios-search-measure` compiles the production Swift packages with optimization for the iOS Simulator.
It measures construction, all 2,200 fixture queries, and an offline national import in separate processes.
The resident peaks include the retained ranking fixture.
The command also records three installed VerificationRelease app relaunches until search preparation finishes.
First-run setup stays outside the app timer, filesystem caches remain uncontrolled, and physical iPhone performance remains unmeasured.
Package tests cover migration, complete and delta imports, offline bundles, mapping rejection, duplicate records, retained reads, and cleanup.
The ranking proofs establish their declared integer contracts and leave filesystem durability, UIKit, linguistic accuracy, and operating-system scheduling as external boundaries.

The synthetic provider corpus assigns readings for `公開` and `図書館` to exercise the reading route.
The Digital Daijisen entries for [the public-access headword](https://kotobank.jp/word/%E5%85%AC%E9%96%8B-494236) and [the library headword](https://kotobank.jp/word/%E5%9B%B3%E6%9B%B8%E9%A4%A8-105194) support the lexical kana.
The corpus preserves lexical kana and performs no romanization.
The [National Institute's conversion notes](https://chamame.ninjal.ac.jp/about_romanise.html) distinguish lexical readings from spelling conventions and pronunciation forms.
