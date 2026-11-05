---
date: 2026-11-05
---

# Rank device search with place preferences and gated readings

## Status

Accepted.
The construction strategy is partly superseded by [reading packed search structures](read-packed-search-structures-without-startup-reconstruction.md).
The implementation brief selects the frozen research scorer.
This supersedes the device name-matching and ranking parts of [word matching](match-every-search-word-in-the-name-region-or-category.md) and [saved-directory search](search-the-saved-directory-on-the-device.md).
The complete-telephone-number rule stays in force.

## Context

Literal word matching misses kana input, spelling errors, and incomplete recollections of facility names.
The unchanged scorer frozen on 2026-11-05 reached 443/564 top-1, 489/564 top-3, and 520/564 top-10 on the independently authored second blind set.
The corresponding percentages are 78.55%, 86.70%, and 92.20%.
The existing matcher reached 269/564 top-1, or 47.70%, on the same queries.
The benchmark describes authored targets on 667,696 national contacts, rather than future user accuracy.
Its name-table SHA-256 is `1112018e4ed078b29b811fa174d80ac416bc3764640c75206ae30358c8f68fa8`.
The first blind set informed geographic handling, so its 414/500 top-1 result is development evidence.

## Decision

Provide `createRankedSearch` at the existing local-search boundary.
It consumes the decoded name index and the matching [ranking companion](publish-snapshot-bound-forgiving-search-artifacts.md), constructs pure search functions, and returns at most 100 scored row positions.
Empty input and input beyond 256 folded Unicode code points return no candidates.
Names, categories, region codes, and telephone displays stay in the name index.

Protect written exact names first, including the original compatibility-normalized spelling before variant-equivalent spellings.
Give exact names score 1,000,000 and keep duplicate contacts as separate rows.
For other queries of one or two code points, rank literal postings by name length and row position.
For longer queries, retrieve at most 200 lexical candidates by rarity-weighted integer bigram Dice and rerank them with the frozen 70:30 bigram and unigram mixture.
Read the integer inverse document frequencies from the companion.

Build up to eight query reading paths from the corpus and dictionary lexicons.
Prefer exact reading candidates within the reading route, otherwise combine its six rarest available literal and reading trigrams and keep at most 512 candidates.
The reading score preserves the exact, anchored-reading, and fuzzy score bands of the frozen scorer.
Select the reading route when the query matches retained exact-kana aliases, the conservative complete-reading rule succeeds, or the frozen two-feature tree selects it.
The tree selects reading only when the reading-to-lexical score ratio exceeds 1250 per thousand and the kana share exceeds 500 per thousand.
The conservative rule requires a reading score of at least 900,000 and a lexical score no greater than 600,000.
A query with Han characters requires a reading score greater than 900,000, preserving a literal trigram anchor.
Production needs the selected tree's two features, rather than its unused training features or single-result confidence metadata.

Recognize separate prefecture and municipality words, their supported administrative suffix variants, and city-to-ward associations from the catalog.
If removing place words leaves no name text, keep the original interpretation.
Merge candidate routes for both the original and remaining name query.
A candidate satisfies a place condition through its prefecture, municipality, or a literal occurrence of the word in its name.
Prefer candidates satisfying every condition while keeping alternatives outside that region.
Without a separate place word, the longest place prefix breaks equal score tiers.
Embedded text keeps its name role.

Encode a nonexact raw score as `floor(raw * 499999 / 1000000) + (preferred ? 500000 : 0)`.
This places every preferred candidate before every nonpreferred candidate while keeping all nonexact scores below an exact name.
Secondary-route additions receive zero raw score.
Break remaining ties by raw score, region preference, and ascending row position.
The reading route uses ordinal UTF-16 string comparison before its own row tie, matching the frozen reference.

Exclude prominence priors.
The research's strict prominence tie-breaker produced no top-1 fixes, and its additive term produced two regressions without a fix on the curated population.
Exclude the extra 1,285 Wikidata kana aliases.
They changed zero target ranks among 10,610 development queries, which included no query requiring an expanded-only kana form.
That limited coverage supports avoiding extra data and entity joins, rather than a universal claim about kana aliases.
Keep the 122 existing aliases as explicit, sourced repairs.

## Consequences

The website and iPhone adapters can consume one deterministic ranked-list contract.
The server continues using its existing matching policy, as [the fallback decision](show-one-ranked-list-with-a-server-fallback.md) specifies.
The selected policy sends no query to a service and learns nothing from query logs.
It can still miss a target outside the bounded pool or rank an ambiguous exact name before another intended facility.
Incorrect proper-name reading proposals and duplicate institutions remain empirical limitations.

`tools/prove.ts` translates the actual integer policy to Dafny, checks the complete inventory, and rejects altered score bands, tier limits, reading thresholds, and locked-route guards.
Native tests compare every admitted preference score with independent BigInt division.
The shared fixture records complete national rankings for at least 2,000 queries after comparison with the unchanged frozen scorer.
These checks establish arithmetic contracts and finite ranking agreement.
They don't establish the truth of target labels, every linguistic reading, future precision, or physical-device performance.
Object traversal, Unicode normalization, candidate retrieval, and sorting remain native-test boundaries.
