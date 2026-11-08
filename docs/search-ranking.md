# Device name ranking

Forgiving search runs only in explicit local website development.
The production website, server, and every iPhone and Android configuration use literal matching.
The [iPhone QA alignment decision](adr/keep-qa-search-aligned-with-the-release-app.md) removes the experimental native scorer and its companion downloads.
The [distribution decision](adr/keep-forgiving-search-in-qa-and-local-development.md) records the resource costs and build boundaries.
Run `mise x -- just dev-forgiving` to build and serve the website scorer locally over HTTPS.
The optional port argument defaults to 8787, and `DIAL_LOCAL_STATE` selects the existing seeded local state.
The recipe passes `--local-forgiving-search` to the development build and loopback preview commands.
The build command rejects the option in production mode, and the browser also requires a loopback hostname.
Every ordinary build keeps the flag off, regardless of deployment environment variables.
An ordinary preview rejects a build that contains the local scorer.
The local recipe uses workerd's HTTPS socket to preserve the Brotli bytes and response headers that the development HTTP proxy changes.
The browser uses Miniflare's self-signed loopback certificate, and source changes require another recipe run.
The production worker loads only the name index, and its build gate rejects packed scorer code and local scorer chunks.
Vite's [app build API](https://vite.dev/guide/api-environment-frameworks) accepts the local build configuration.
The [worker constructor](https://vite.dev/guide/features.html#web-workers) uses module mode for the local scorer's dynamic import.

`createRankedSearch` in `src/core/local-search.ts` exposes the frozen facility-name scorer.
The constructor accepts a decoded `SearchIndex` and a decoded `RankingArtifact` with the same snapshot and contact count.
It performs no network, file, clock, or environment access.
The returned search function accepts the original facility-name input and returns one ranked array of `{ row, score }` values.
Each row is a 0-based position in the name index and maps to D1 rowid `row + 1`.
The row supplies the display name, category, region, and telephone displays.
The score is an integer from zero through 1,000,000, with whole-name exact results first and at most 100 results.

Native and file adapters verify compressed and decoded sizes and SHA-256 digests from discovery before decoding either artifact.
The website uses the browser's Brotli HTTP decoder and verifies decoded size and SHA-256.
The worker compares compressed length, digest ETag, content coding, and snapshot response headers with discovery.
The HTTP decoder doesn't expose compressed bytes for hashing, so compressed-byte integrity relies on the checked publication and HTTPS delivery paths.
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
The [server fallback decision](adr/show-one-ranked-list-with-a-server-fallback.md) keeps the server matcher, and [category previews for ranked results](adr/group-ranked-results-into-category-previews.md) defines the presentation.
The local forgiving-search worker admits both artifacts before constructing the scorer and keeps the server fallback when admission fails.
Git history preserves the retired Swift scorer.

## Packed artifact loading

The builder publishes `public-phonebook-search-ranking/2` with precomputed row statistics, sorted dictionaries, compact reading choices, and compressed posting lists.
The [packed-search decision](adr/read-packed-search-structures-without-startup-reconstruction.md) describes the layout and its verification boundary.
The decoder keeps byte views instead of expanding national dictionaries and postings.
The scorer reads those views directly and preserves the same query and result interface.
Retained format 1 artifacts continue using the original construction path.

Local forgiving search uses `decodeSearchIndex(bytes, true)` after digest verification to view name and telephone lines through offsets.
The default decoder still performs complete row validation for data checks and existing callers.
Complete data regeneration establishes normalization and dictionary ordering before publication.
The worker checks decoded identities and structural bounds before admitting the pair.
The worker uses the Fetch standard's [no-store request cache mode](https://fetch.spec.whatwg.org/#concept-request-cache-mode) to avoid keeping another decoded HTTP cache entry.
An admitted worker continues searching offline within its page lifetime.
A fresh page requires another artifact download.
It decodes result rows when needed and keeps server search available after failed admission.

The packed header's `sourceSha256` identifies the canonical format 1 source used by the unchanged 2,200-query fixture.
The prepared manifest's `uncompressedSha256` identifies the actual packed bytes.
The contract tool verifies the actual files before comparing the source fingerprint and every returned ranking.
The data gate independently regenerates the fingerprint and complete packed file from the prepared database and pinned readings.
Never use the source fingerprint as the packed file's checksum.

## Literal search from temporary files

The production Worker streams the existing index into origin-private files instead of retaining the transport buffer and every decoded name.
Admission checks transport metadata, decoded length, SHA-256, header relationships, UTF-8, canonical name order, telephone syntax, and every category and region reference.
The Worker derives folded names and row offsets in bounded batches.
After admission, search reads fixed file buffers and keeps category codes, region codes, and one rank byte per contact.
The retained typed buffers have an 8 MiB limit.
Header objects, JavaScript heap, browser processes, and allocator reserves also use memory.
The national 672,133-contact snapshot uses 4,787,736 bytes of retained typed buffers.
Queries keep counts and bounded category previews rather than every matching row identifier.
Continuations read the cached ranks, and visible cards read their display names and telephone numbers from files.
UTF-8 matching chooses an anchor byte from the public names' byte frequencies and preserves the existing exact, prefix, substring, and place ranks.
Generated Unicode cases and national parity compare the result with the existing reference.

Each Worker owns a separate temporary directory and holds a Web Lock until disposal.
Startup cleanup removes inactive directories while preserving active tabs.
The Worker publishes a replacement before removing its retired files.
Only public dataset bytes and derived search structures enter the files.
Queries and diagnostics never enter the files.
See the [file-backed search decision](adr/read-browser-search-data-from-temporary-files.md).
Storage denial uses the existing server fallback.
Playwright's WebKit private contexts reject the storage root, so normal-browser tests and measurements use temporary persistent profiles.
The separate private-browsing test checks server fallback.
The [Playwright context contract](https://github.com/microsoft/playwright/blob/v1.64.1/docs/src/api/class-browsertype.md#async-method-browsertype-launchpersistentcontext) defines the persistent context's lifetime.

Local result links carry their return search in fragments through facility and source pages.
The root page restores that search after admission or a fallback decision.
The [navigation decision](adr/keep-local-search-return-paths-out-of-requests.md) prevents nested return parameters from sending local queries.
Fragment-dependent links wait for hydration, while `noscript` preserves ordinary server navigation.
The hydration boundary prevents an early source or return action from discarding the fragment.
Browser history can keep address fragments, and the privacy page describes that behavior.

`tools/search-performance.ts` rebuilds the current sources and records the Worker's actual load mode.
The report keeps the 1,500 ms admission budget after the last artifact byte arrives and a 400,000,000-byte sampled added physical-footprint budget for both modes.
Resident size and its historical 400,000,000-byte verdict remain separate fields.
Literal search uses a 50 ms Worker round-trip p95 budget.
The value adopts the input-processing allowance from the [Response, Animation, Idle, and Load (RAIL) model](https://web.dev/articles/rail).
The round trip doesn't measure paint or the complete visible response.
The complete-ranking p95 baseline is 10.2 ms for Chromium and 11.2 ms for Chromium with its existing fourfold page CPU setting.
The baseline is 10 ms for desktop WebKit and 13 ms for mobile WebKit.
Supply `--contract tests/fixtures/search-ranking.json` to select the explicit forgiving-search build and frozen complete-ranking workload.
Supply `--process-tools DIRECTORY` for attributed browser process measurements.
The report refuses to pass missing physical-footprint samples or missing latency samples for the selected mode.
Every profile uses a fresh temporary persistent browser profile and records that storage context explicitly.
Earlier private-context measurements aren't a paired comparison with the persistent-profile measurements.
Supply `--profile NAME` for a focused investigation, and omit it for the required four-profile campaign.
The release gate's existing performance observation keeps the budget fields with the candidate evidence.

The national literal campaign on 2026-11-09 measured Chromium's Worker round-trip p95 at 46.6 ms.
Chromium with fourfold page CPU throttling took 48.2 ms.
Desktop and mobile WebKit took 39 and 37 ms.
Admission after artifact arrival took 857–911 ms.
The sampled added physical footprint ranged from 195,461,816 to 296,419,760 bytes across the complete owned browser process trees.
Retained search buffers use 4,787,736 bytes within an 8 MiB guard.
Complete browser processes still require much more than a few megabytes.
The process figures include runtime and rendering costs outside the typed search buffers.

On macOS, the maintained step meter also reads current and lifetime peak physical-footprint counters through `proc_pid_rusage`.
[Apple's memory guidance](https://developer.apple.com/videos/play/wwdc2022/10106/) distinguishes physical footprint from resident memory when assessing process limits.
Each poll adds current process footprints, while the separate sum of process lifetime peaks doesn't represent a simultaneous peak.
The native counter rejects missing processes and invalid samples instead of substituting resident memory.
The owner selected physical footprint as the primary process-memory metric.
Raw native lifetime peaks can lag current readings, so their ordering doesn't invalidate a positive current counter or replace it with an invented peak.
Chromium's separate Chrome DevTools Protocol counters report main-thread and Worker heaps after the timed workload.
WebKit and physical-phone heap inspection remain separate checks.
The process sampler and optional region summary run only during an explicitly invoked local experiment.
Production pages don't collect or upload performance telemetry.

The website groups results into category previews of up to three results, with a continuation of 30 results per category.
The production worker groups literal matches as the server does.
The local forgiving-search worker groups its ranked candidates by category, placing each category where its first candidate appears and keeping rank order inside it.
Its internal messages include the integer score for contract inspection, while result cards leave scores out.
Complete telephone numbers keep exact-number matching in index row order.

`tests/fixtures/search-ranking.json` declares `public-phonebook-name-ranking/1`, the exact snapshot, both decoded artifact digests, and complete expected row-and-score pairs for every fixture query.
The fixture records all returned candidates, including score ties and secondary-route candidates.
The current iPhone tests exercise literal search without a ranking companion.
String comparison inside the reading lane follows ordinal UTF-16 order, while n-grams and query bounds use Unicode code points.
The frozen scorer uses exact integer arithmetic for weighted sums and score products.

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

## Local preparation and quality checks

`mise x -- just data-prepare SOURCE OUTPUT` prepares a production snapshot without the ranking companion or the Sudachi analyzer.
The production manifest keeps the name index used by literal device search.
Remote storage, candidate data admission, and publication reject manifests that declare a ranking companion.
Remote archive upload also rejects a ranking file hidden among other declared files.
The upload inventory excludes undeclared local ranking files.

Prepare a separate local experiment bundle with `mise x -- just data-prepare-forgiving SOURCE OUTPUT` to generate the snapshot-bound ranking companion.
Install the pinned analyzer with `mise install` in `tools/readings` before preparing a national QA bundle.
The first analyzer run downloads the checksum-pinned full dictionary into `.local/search-readings/`.
`mise x -- just data-check BUNDLE` still verifies a declared ranking companion by regenerating the readings and posting bytes, so checking a national QA bundle also needs the analyzer.
Checking a production bundle needs no analyzer.

`tests/fixtures/search-quality/manifest.json` fixes eight evaluation populations and their top-1, top-3, and top-10 thresholds.
The corpus retains 11,174 query records from the curated sets, both blind sets, and the original synthetic test splits.
The corpus excludes training records.
The committed JSON Lines files preserve the research records and audit fields in their original order.
The manifest records source and filtered-file digests, the frozen scorer and report digests, and the original national name-table identity.
`targets.json` binds the research rowids to 10,067 stable contact IDs.
Evaluation resolves those identities in the candidate database and verifies that its row order matches the candidate search index.
A missing target fails the campaign instead of reducing its denominator.
Changing an evaluation population or target requires reviewed corpus maintenance.

```sh
mise x -- just search-quality-forgiving BUNDLE .local/search-quality.json
```

The explicit local command verifies the corpus and both snapshot artifacts before evaluating the QA scorer.
A query succeeds at a cutoff when any declared acceptable target appears within that cutoff.
Every query contributes to the denominator, including queries with no hits.
Each population must keep its declared size and meet all three thresholds.
Improvements in one population or cutoff can't offset a regression elsewhere.
The JSON report binds the corpus, candidate snapshot, and decoded artifact digests to the measured counts and verdict.

The candidate `parity` stage checks literal device/server parity without running the national forgiving-search quality campaign.
Release CI neither loads the Sudachi analyzer nor retains a forgiving-search quality report.
The fast gate runs small metric, corruption, target-resolution, split-admission, and regression-control fixtures without loading the national corpus or analyzer.
The source-translated `qualityPasses` proof establishes the threshold decision over its declared integer domain, and a relaxed top-1 threshold must fail verification.
The native tests keep an empty ranker as a regression control.

The independent blind population retains minima of 443, 489, and 520 successes among 564 queries.
Those counts correspond to 78.55% top-1, 86.70% top-3, and 92.20% top-10.
The first blind set is development evidence because its results informed the place policy.
The retained sets measure regression on fixed labels.
They don't estimate production traffic or establish a person's intended result.
Corpus maintenance must preserve that distinction and must not derive lower minima from a regressed implementation.

The one-time import command verifies the frozen research inputs and reports before copying their evaluation splits and baseline counts.
It requires a fresh output directory and leaves existing files intact.

```sh
mise x -- node tools/search-ranking-contract.ts import-quality BUNDLE OUTPUT LABORATORY
```
