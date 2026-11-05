# Device name ranking

`createRankedSearch` in `src/core/local-search.ts` exposes the frozen facility-name scorer.
The constructor accepts a decoded `SearchIndex` and a decoded `RankingArtifact` with the same snapshot and contact count.
It performs no network, file, clock, or environment access.
The returned search function accepts the original facility-name input and returns one ranked array of `{ row, score }` values.
Each row is a 0-based position in the name index and maps to D1 rowid `row + 1`.
The row supplies the display name, category, region, and telephone displays.
The score is an integer from zero through 1,000,000, with whole-name exact results first and at most 100 results.

Verify compressed and decoded sizes and SHA-256 digests from discovery before decoding either artifact.
The index's `snapshot` and row count must match the ranking companion.
`decodeRankingArtifact` rejects unsupported formats, inconsistent counts, invalid ordinals, noncanonical varints, and trailing data.
The constructor rejects a snapshot mismatch and invalid integer lexical weights.
Admit the pair together, and keep the server search when loading or admission fails.

```ts
import { createRankedSearch } from "../src/core/local-search.ts";
import { decodeSearchIndex } from "../src/core/search-index.ts";
import { decodeRankingArtifact } from "../src/core/search-ranking-artifact.ts";

const index = decodeSearchIndex(verifiedIndexBytes);
const ranking = decodeRankingArtifact(
  verifiedRankingBytes,
  index.header.snapshot,
  index.rows.length,
);
const search = createRankedSearch(index, ranking);
const hits = search.search(rawFacilityName);
const first = hits[0];
const facility = first === undefined ? undefined : index.rows[first.row];
```

The example assumes that the adapter has verified both byte arrays and owns `rawFacilityName`.
Classify complete telephone numbers with the existing query parser and preserve their existing exact-number lookup.
Pass the original name text to the name scorer after classification, because pre-folding would erase the exact original spelling guard.
Empty or whitespace-only name input returns an empty array.
Input beyond 256 folded Unicode code points also returns an empty array.
Place-only input keeps its original interpretation.
Queries with one or two code points use the bounded literal route.

The [scorer decision](adr/rank-device-search-with-place-preferences-and-gated-readings.md) defines retrieval, reading selection, place conditions, score encoding, and ties.
The [presentation decision](adr/show-one-ranked-list-with-a-server-fallback.md) defines the phase 2 single list and the retained server matcher.
Phase 1 leaves the website worker and iPhone screens on their current implementations.
Their adapters must adopt the new core or its Swift equivalent and the shared contract before changing presentation.

`tests/fixtures/search-ranking.json` declares `public-phonebook-name-ranking/1`, the exact snapshot, both decoded artifact digests, and complete expected row-and-score pairs for every fixture query.
The fixture records all returned candidates, including score ties and secondary-route candidates.
The iPhone tests should decode the same JSON and compare every pair using 0-based row positions.
String comparison inside the reading lane follows ordinal UTF-16 order, while n-grams and query bounds use Unicode code points.
Swift adapters must preserve both choices rather than using locale-sensitive ordering or grapheme clusters.
Use 64-bit arithmetic for weighted sums and score products, whose intermediate values exceed 32-bit bounds.

```sh
mise x -- node tools/search-ranking-contract.ts check .local/national-core tests/fixtures/search-ranking.json
mise x -- just check
mise x -- just prove
```

The contract command verifies both artifact identities and every fixture ranking on national data.
Generation runs its supplied frozen reference in a separate process before constructing the production scorer.
The separate process prevents both national indexes from occupying one JavaScript heap during comparison.
The fast gate uses small unit and property fixtures without national files or Python.
The proof gate binds actual policy sources, their generated Dafny models, expected counts, and rejected mutations.
Independent BigInt checks cover every integer preference score and seeded Dice boundaries.
Unicode normalization, object traversal, candidate retrieval, and sorting have native checks rather than an unbounded theorem over all JavaScript strings.
The arithmetic proofs don't certify benchmark target labels or a person's intended reading.
