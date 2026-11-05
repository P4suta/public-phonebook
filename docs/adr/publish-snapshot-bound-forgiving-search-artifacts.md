---
date: 2026-11-05
---

# Publish snapshot-bound forgiving search artifacts

## Status

Accepted.
The implementation brief authorizes the frozen research scorer and its build-time artifacts.
This amends [the name-ordered index decision](publish-a-name-ordered-search-index-for-the-website.md) by adding a companion artifact without changing that index's format or row order.

## Context

Device ranking needs lexical candidates and reading candidates over the same immutable national directory.
Building inverse document frequencies on each client risks divergent rounding, and shipping the morphological analyzer would add a full dictionary to every installation.
The 2026-11-05 research used SudachiPy 0.7.0, Python 3.13.16, and the full SudachiDict 20261015.
All 667,696 concatenated readings agreed across split modes A, B, and C in that snapshot.
Mode C keeps the full-name proposal, while in-vocabulary mode A tokens and single-character dictionary lookups supply the query lexicon.
The observations concern the retained snapshot and don't establish proper-name reading accuracy.

## Decision

Publish `search-ranking.br` with declared format `public-phonebook-search-ranking/1` beside `search-index.br`.
The existing snapshot preparation command generates the companion before writing its ready manifest.
The prepared manifest declares its compressed and decoded byte lengths and SHA-256 digests.
Retained manifests without the optional companion stay readable.
`/api/search-ranking` discovers the companion, and its snapshot-and-digest URL serves Brotli bytes under the existing site's access and caching policy.
The open-data listing keeps its current complete-directory files.

The decoded artifact begins with `public-phonebook-search-ranking`, a tab, `1`, and a line feed.
A JSON line follows with the snapshot, contact count, analyzer identity, dictionary digest, row readings, token lexicon, aliases, variant map, unknown-gram weight, and two posting dictionaries.
Each posting dictionary entry carries gram text, its frozen integer weight, and its document count.
After the JSON line, lexical bigram lists precede combined literal-and-reading trigram lists in dictionary order.
Lists contain ascending 0-based row positions, delta encoded from an initial position of `-1` as unsigned base-128 continuation bytes.
The first byte's low seven bits hold the least significant digits.
The decoder accepts only the shortest encoding and rejects trailing bytes.
The codec limits contacts to 2,000,000, compressed data to 64 MiB, and decoded data to 256 MiB.
The lexical weight is `max(1, round(1024 * log((contacts + 1) / (frequency + 1))))`, evaluated at build time.
Consumers perform ranking with the serialized integers.

Pin Python and uv in the analyzer directory and Python dependencies in `uv.lock`.
Verify the Works Applications full-dictionary ZIP using SHA-256 `b38318ca26a444cd713a5a377a353308ef38c733c64cc0be905122527516c793` before extraction.
Run the generator with isolated Python and keep its environment and dictionary under `.local/`.
The [SudachiPy API](https://worksapplications.github.io/sudachi.rs/python/api/sudachipy.html) defines token readings, split modes, and out-of-vocabulary flags.
The [dictionary project](https://github.com/WorksApplications/SudachiDict) defines the full edition and distribution.

Keep the research's conservative 13-pair variant map after the existing production fold.
Keep 122 row-and-kana aliases, bound to stable contact IDs and unchanged original display names before converting them to snapshot positions.
The sources remain in `tools/search-aliases.json`.
Reject prominence priors and the extra Wikidata inventory in the scorer decision because neither improved the observed ranking.
Don't interpret an analyzer proposal or a Wikidata entity join as independent confirmation of every institution's reading.
The Digital Daijisen entry for [the library headword](https://kotobank.jp/word/%E5%9B%B3%E6%9B%B8%E9%A4%A8-105194), `図書館`, supports the lexical reading `トショカン` for the document-access facility.
Reading normalization preserves lexical kana and performs no romanization or pronunciation substitution, consistent with the [National Institute's distinction between lexical analysis and spelling](https://chamame.ninjal.ac.jp/about_romanise.html).

## Consequences

The data check regenerates all readings using the pinned analyzer, rebuilds the posting dictionaries from the prepared database, and compares the entire decoded artifact.
Storage and fetch paths keep the companion under its content-addressed key.
Small codec, HTTP, and storage fixtures run in the fast gate without Python or national data.
National generation and verification run at the data and release boundaries.
The existing clients keep their current search until their adapters load the companion.

Computing weights on devices would introduce language-specific floating-point work into parity.
Shipping the full dictionary would add data that query conversion doesn't need beyond the corpus lexicon and selected dictionary entries.
Replacing the existing index in place would require current clients to change format during integration of the ranking core.
Generation now requires the pinned Python environment and a verified dictionary cache or its public download.
The data check establishes reproducibility and snapshot binding, while ranking quality and linguistic interpretation require separate fixtures and evidence.
