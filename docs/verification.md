# Verification boundaries

Run the standard checks with `mise x -- just check`.
The gate runs formatting, strict Clippy, TypeScript checking, browser-test linting, Rust unit and integration tests, dependency audits, and a secret scan.
Run `mise x -- npm ci` and `mise x -- npm run browsers` to install the locked browser-test dependencies and browser builds.
Run `mise x -- just service-check` after preparing the service bundle to include real-data reconciliation, proofs, native browser suites, and the Cloudflare runtime.
Run `mise x -- just workflow-check` to validate the hosted workflow's syntax and expressions with pinned actionlint.

## Production origin

Run `mise x -- just e2e-production` after deploying the checked candidate to `https://dial.page`.
The command reuses all 14 local Cloudflare workflows against the public origin without starting a local server.
After those pass, one additional workflow downloads the complete national CSV and reconciles every record and coverage cell.
It verifies the exact prepared snapshot, contact count, coverage, static asset hashes, schema validators, browser protections, search, source navigation, downloads, API errors, narrow layouts, and accessibility.
The target is fixed and TLS verification remains enabled.
Tests retain videos, traces, screenshots, and a separate production report.
The interactive workflows send bounded test queries and small filtered downloads.
The complete-export workflow runs once and retains the downloaded file outside version control.
The tests exercise Chromium and emulated iPhone behavior, not physical handset imports or production load capacity.
The equivalent explicit command is `mise x -- just check --data --proofs --fuzz --browsers --cloudflare`.

## Parser corpus replay

Run `mise x -- just fuzz-replay` for the committed parser corpus.
The target imports the production core and checks prefecture and municipality identities, snapshot bytes, export format round trips, canonical telephone values, table spans, escaping, and UTF-8 line folding.
Normalized telephone values, escaped vCard text, and folded vCard text have separate private-field types.
Adapters explicitly render or convert those types at storage and HTTP boundaries.

The container pins cargo-fuzz 0.13.2, libfuzzer-sys 0.4.13, Rust nightly-2026-10-22, the Rust base image, and the C++ compiler packages.
The command replays the nonempty corpus with AddressSanitizer, a fixed seed, a 256-byte input bound, and no mutation campaign.
It also requires a deliberately false target to fail at its expected assertion with exit code 77.
The source-bound receipt includes the exact image, harnesses, lockfiles, runner, and corpus hashes.
An empty or oversized corpus input, changed source, tool failure, or unexpected negative-control outcome prevents a receipt.
Logs and receipts remain under `target/`, and crash artifacts remain outside version control until a maintainer selects a regression seed.

Corpus replay covers the committed finite inputs and checks the native Unicode adapter under those inputs.
It complements the bounded core proofs and does not establish correctness for every possible byte sequence.
The default gate type-checks both fuzz targets and audits both Cargo lockfiles.
The complete service gate also runs corpus replay before deployment.
Rust, Node.js, Just, Taplo, Biome, cargo-audit, and Gitleaks versions are pinned in `mise.toml`.
Playwright, Axe, TypeScript, and CSV parser versions are pinned in `package.json` and `package-lock.json`.
The dependency audit uses RustSec revision `40f5be6fb12ed93fc591bf4ab23b7d793b3f2239`.
Updating this revision is a separate freshness decision.
The current dependency graph reports maintenance warnings for transitive `basic-toml` and `fxhash` dependencies.
Warnings remain visible and are not counted as vulnerability fixes.

## Source-bound proofs

Run `mise x -- just prove` with a working Docker engine.
The command builds the pinned Linux amd64 Kani 0.68.0 image from `verification/Dockerfile`.
It uses a temporary copy of the actual production core and checks the source hashes again before writing a receipt.
On owner machines it uses `dotfiles bounded run` when available.
The portable fallback applies 2 GiB memory, no additional swap, two CPUs, 256 processes, and a 900-second resource stop.
A resource stop or tool error is inconclusive and fails the gate.
Proof verdicts use fixed input and unwind bounds, not elapsed time.

| Production function | Harness | Domain and property |
| --- | --- | --- |
| `canonical_digits` | `canonical_numbers_are_bounded_and_reparse` | Every byte sequence up to 12 bytes, both domestic and international modes; accepted outputs have 11 or 12 ASCII digits beginning with 81 and reparse identically; unwind 14 |
| `escaped_byte` | `special_bytes_cannot_add_properties` | All 256 byte values; bounded output and escaped separator/newline bytes; unwind 2 |
| `MunicipalityCode::parse` | `municipality_codes_preserve_validated_digits` | Every byte sequence up to 7 bytes; accepted codes preserve five ASCII digits, have a prefecture prefix from 01 through 47, satisfy any supplied checksum, and reparse; unwind 9 |
| `classify_phone_character` | `phone_characters_preserve_the_declared_alphabet` | Every Unicode scalar value; digit outputs are ASCII digits and each classification matches the declared digit, prefix, and separator sets; unwind 16 |
| `TableSpan::parse` | `table_spans_refuse_overflow_and_preserve_bounds` | Every `usize` start, width, and height; exact admission, checked addition, at most 64 columns and 1,000 rows; unwind 2 |
| `admit_childcare` | `childcare_admission_excludes_inactive_and_individual_care` | Every typed facility kind and operating status; only an operating organizational facility is admitted and its type is preserved; unwind 2 |
| `PageWindow::new` | `page_windows_cover_results_without_arithmetic_overflow` | Every 64-bit `usize` total and requested page; clamping, bounded offsets and lengths, contiguous pages, complete final page, and no arithmetic overflow; unwind 2 |
| `ChunkPlan::new` | `streaming_chunk_plans_preserve_capacity_and_progress` | Every 64-bit buffered and incoming length; exact admission, progress, and the 64 KiB capacity limit; unwind 2 |
| `PrefectureCode::parse` | `prefecture_codes_admit_exactly_the_47_ascii_codes` | All 65,536 two-byte inputs; exact admission of 01 through 47, preserved digits, and reparse identity; unwind 3 |
| `ExportFormat::parse_bytes` | `export_formats_reject_unknown_names_and_preserve_the_selected_mime` | Every byte sequence up to five bytes; exact format admission, extension round trip, and MIME selection for all three variants; unwind 32 for the longest MIME comparison |
| `csv_text_boundary` | `csv_text_prefixes_preserve_text_boundaries_for_every_unicode_scalar` | Every optional Unicode scalar; exact quote action for ASCII controls and space, formula-leading punctuation, and its declared full-width forms; unwind 9 |
| `SnapshotId::parse` | `snapshot_identities_admit_exactly_lowercase_sha256_bytes` | Every 64-byte array; exact lowercase ASCII hexadecimal admission, byte preservation, and reparse identity; unwind 66 |
| `ApiProblemKind` | `api_problems_preserve_status_codes_and_retry_semantics` | All five problem variants; status, machine code, retry policy, unique codes, and nonempty titles; unwind 64 |

All thirteen harnesses keep default memory, arithmetic, unwinding, and assertion-reachability checks and include reachable cover properties.
The gate requires all thirteen named harnesses and a nonempty successful summary.
A separate, intentionally false escape claim must fail at its expected assertion.
Logs and the source-bound receipt are written under `target/`.
The receipt records the immutable image identity and source hashes and is regenerated by each run.

Kani's supported Rust semantics, compiler, solver, and pinned image are trust assumptions.
These proofs do not cover the Unicode string adapter, the whole vCard serializer, SQLite FFI, HTTP, TLS, Excel or CSV parsing, source truth, or physical device behavior.
Integration and regression tests exercise those supported software boundaries with concrete fixtures.
No second abstract model is used to claim a proof of the adapters.

## Behavioral and source checks

The test suite exercises Japanese telephone spellings, rejected malformed/foreign numbers, UTF-8 folding, vCard injection escaping, merged and compact spreadsheet layouts, missing-number accounting, corrupted caches, shared directory locks, incomplete coverage, shared numbers, parameterized filters, HTML escaping, pagination, and exports beyond the first page.
Public CSV fixtures check office and corporate telephone separation, fax exclusion, quoted fields, both institution header layouts, release selection, publisher origins, deleted registers, archive ambiguity, service-only duplicates, malformed geographic codes, missing numbers, and reuse attribution in every export format.
Published compatibility hyphens and Unicode whitespace have regression fixtures in both the normalizer and the extractor.
The generator for digit-width and separator properties includes those forms.
`inspect-source` profiles CSV files and CSV archives through the production telephone extractor and prints bounded invalid-number examples.
Regression tests reject duplicate prefecture inventories, contacts outside the declared inventory, source count misattribution, metadata detached from its contact set, invalid contact fields, telephone index corruption, and modified archived sources.
Staging tests verify that failures preserve the active database and remove temporary files, and that only atomic activation makes the replacement visible.
Sixteen simultaneous readers must return the same results, and every shared lock must be released before an update can acquire the directory.
Four Proptest properties each run 1,024 cases with a fixed seed and a 4,096-iteration shrink bound.
They check digit-width normalization, Unicode escaping and folding, CSV round trips, and vCard property injection.
Synthetic fixtures are confined to tests and never substitute for the installed national data.
`mise x -- just validate-data` scans the actual installed database and archived source bytes.
The real-data audit verifies all 47 prefectures, all 39 category inventories, source row reconciliation, canonical telephone values, and the SQLite indexes and integrity result.
Eight categories require contacts in every prefecture, while other zero cells remain explicit.
Pass `--baseline path/to/baseline.sqlite` with `--data` in the full check to compare the active snapshot with an earlier database.
This optional preservation gate rejects removed contacts and changed payloads, and reports the number of additions.
Its fixtures distinguish additions, deletions, changes, and an absent baseline without creating a replacement file.
SQLite remains the external implementation boundary for this comparison; these finite fixtures and the installed snapshot comparison are its current substitute evidence.
It reports unresolved municipalities and prefectural homepage confirmation gaps explicitly.

## Browser workflows and evidence

Run `mise x -- just e2e` for the deterministic fixture suite.
The suite runs 19 directory workflows across desktop Chromium, Firefox, WebKit, Android browser emulation, and iPhone browser emulation.
It verifies search normalization, combined filters, all pagination boundaries, shared numbers, empty states, all export formats, individual contacts, malicious text and URLs, keyboard navigation, responsive layouts, browser errors, and invalid requests.
Three additional source-navigation workflows check readable context before file access, explicit publication and file links, safe URLs, preserved search filters, source categories, and narrow layouts.
Two public-data workflows exercise all 34 public-data and service additions with combined filters, exported attribution, and source navigation.
HTTP integration tests also check HTML response headers, missing contacts, invalid queries, query preservation, and unchanged export provenance.
Axe checks WCAG A and AA rules on populated, filtered, empty, and source-detail states without disabling contrast checks.
The browsers run headlessly and use isolated test profiles.
They do not take over the desktop or open personal address books.

The monochrome design check also runs in the default `just check` gate on Chromium.
It requires the service name as the main heading and immediate access to search.
It inspects parsed stylesheet rules, inline declarations, visible computed styles, and generated pseudo-elements for non-binary colours, gradients, shadows, transparency, filters, and blending.
Twelve prohibited style fixtures must be rejected, while black-and-white typography and solid rules must pass.
The full fixture suite runs these four design checks and 36 behavioral workflows on all five browser configurations, for 200 cases.
The nine service workflows cover automatic loading, recovery, snapshot changes, malformed pages, immediate municipality choices after a prefecture change, repeated page suspension, JavaScript-disabled navigation, all Figma screen states, local fonts, and icon geometry.
Recovery retains displayed records and receives its own accessibility check and screenshot.
The checks cover authored CSS and supported rendered states, not antialiasing pixels or the semantic clarity of arbitrary prose.
Literal copy and meaningful visual encoding still require editorial review.

Run `mise x -- just e2e-national` against the installed real snapshot.
The suite reconciles all 1,833 prefecture/category cells, selects all 47 prefectures through the actual form, searches a real municipal office and a real representative telephone number, and downloads filtered records beyond the first page.
A seventh workflow opens a real medical source page, checks its publisher listing and labelled archive link, and verifies that navigation starts no download.
Additional workflows search all five added categories, check their actual publishers and file formats, and find a real source telephone with a compatibility hyphen.
Twenty-nine service-category workflows also check actual nonempty data, telephone search, complete JSON/CSV/VCF exports, publisher attribution, readable source navigation, preserved filters, and responsive source pages.
All 38 workflows run on desktop Chromium and Android and iPhone browser emulations.
One additional bulk workflow downloads the entire national CSV and streams through every row to check unique contact IDs, canonical numbers, publisher attribution, and per-cell counts.
The bulk validator records failures and aggregate assertions without adding a trace step for each individual row.

Playwright records videos, traces, and screenshots under `test-results/fixtures/`, `test-results/national/`, and `test-results/cloudflare/`.
HTML reports use the corresponding directories under `playwright-report/`.
Responsive screenshots cover widths of 320, 390, 768, and 1,440 pixels.
Each suite owns its server and stops it through the configured shutdown lifecycle.
Existing listeners are refused rather than reused, and failed checks have no automatic retries.

SQLite's bundled C implementation and dependency internals remain external trust boundaries.
The application forbids its own unsafe Rust and uses safe library interfaces.
The existing finite integration checks are the current alternative for these external boundaries.
Revisit this scope if custom unsafe code, shared mutable database writes, native device integration, or a parser with a suitable source-level verifier is introduced.

The civic and childcare adapters use scraper, calamine, csv, zip, encoding_rs, Reqwest, and publisher-controlled documents outside Kani's supported core.
Native fixtures check merged cells, span refusal, exact prefecture discovery, origin restrictions, childcare status and privacy exclusions, source-specific numeric telephone repair, branch phone separation, pension primary addresses, fax exclusion, school-code families, and the hash-bound police transcription.
The production HTML table expander uses the proved `TableSpan` constructor, and the production childcare CSV adapter calls the proved admission function after parsing source labels into typed values.
These proofs assume those adapters classify source labels correctly; finite fixtures and real imports test that connection without claiming a proof of source truth or parser internals.
Revisit this alternative if those parser dependencies gain suitable source-level verifier support or the source layouts and admission policy change.

## Checked types and runtime boundaries

Rust checks all workspace targets with warnings denied.
The HTTP DTO is validated before constructing checked regions, prefecture codes, categories, and export formats.
Private fields prevent arbitrary construction of checked search values and prefecture codes.
A compile-fail doctest checks the prefecture constructor boundary.
SQL filters consume the checked region and category values.
The HTTP and CLI export paths use the same exhaustive format type and MIME selection.

TypeScript strict checking covers browser source, Worker source, configuration, and tests.
Unchecked indexed access and exact optional properties are enabled.
The feed page has a private data field and a private constructor, so an unchecked object cannot satisfy its type structurally.
Five expected compile errors exercise invalid construction, mutation, loading without a controller, and suspension without a resumable state.
A separate compile-only fixture requires the inferred loopback namespace to carry the actual container class.
External SDK declarations and generated runtime types remain an explicit trust boundary.
The gate regenerates runtime types with the pinned CLI and checks the owned adapters.
`just web-check` recompiles browser TypeScript to an isolated directory and compares the exact emitted JavaScript with the embedded file.

Kani checks the supported Rust core, not SQLite, the HTTP runtime, the browser event loop, or Cloudflare's control plane.
Its frontend does not compile TypeScript or the DOM APIs used by the feed.
The checked alternative for those boundaries is strict typing, runtime shape validation, finite fault injection, and real headless browser and local Cloudflare checks.
The substitute does not establish an unbounded liveness proof or a proof of the JavaScript engine.
Revisit it if the project adopts a verifier covering the actual TypeScript and DOM semantics, or changes the async state protocol.

HTTP contract tests cover styled errors, response protections, snapshot and request identities, unavailable databases before download headers, and capacity held through body consumption.
The stream adapter checks chunk limits, byte preservation, and receiver disconnection using the real Tokio channel.
The pure chunk plan is proved separately.
These checks assume the channel and HTTP libraries implement their documented wakeup and cancellation contracts.

The CSV adapter uses the proved quote decision and validates canonical telephone cells separately.
Native fixtures check apostrophe insertion, original JSON values, separators, and Unicode round trips.
This establishes emitted CSV bytes, not universal spreadsheet interpretation or safety after a spreadsheet rewrites the file.
Physical spreadsheet import behavior remains outside this proof boundary.

## Public API contract checks

Eight native API contracts cover anonymous discovery, all catalog inventories, source attribution, full filtered exports, snapshot conflicts, query errors, UTF-8 byte limits, opaque identifier escaping, HEAD, CORS, and database failures before download headers.
The schema is generated by pinned Utoipa 6.0.0 from the Rust DTOs and the actual `ExportContact` serializer.
Pinned jsonschema 0.60.2 validates actual JSON responses against that schema with HTTP and file retrieval disabled.
The catalog must contain exactly the category identifiers declared by the schema.
Planted missing metadata and a numeric canonical-phone value must be rejected.
These checks establish the tested response contracts, not the truth of source records or a proof of the schema libraries.

Three additional browser workflows verify API discovery, anonymous requests despite a website cookie, safe display of source text, URL selection, response headers, error recovery, narrow layouts, and accessibility.
Cross-origin fetch and schema revalidation use a real HTTP consumer on a separately allocated loopback port.
The test owns and closes that server explicitly and leaves browser network protections enabled.
The Cloudflare cases also exercise the real API, bulk retrieval, source links, preflight, schema validators, edge problems, and the local API script.
Vite's generic CORS middleware is disabled so the Worker supplies the public API's actual preflight policy during local checks.

The Rust core proofs cover snapshot syntax and the finite problem policy.
Kani does not model Axum's HTTP routing, Serde's macros, SQLite, JSON Schema semantics, or the browser and Worker networking implementations.
The checked alternative is the generated contract, independent response validation with malformed controls, native HTTP fixtures, fault injection, and actual browser and local Cloudflare checks.
Revisit this boundary if those dependencies gain suitable source-level verifier support or the API adds authentication, writes, or another pagination protocol.

## Cloudflare checks

Six finite lifecycle cases import the production Container adapter with typed ports and a controlled delay boundary.
They cover pinned startup, internet access turned off, health refusal, probe-body release, twenty concurrent requests, client cancellation, timeout restoration, image replacement, idle restart, allocation recovery, the 45-attempt readiness bound, and recovery after failure.
The native Container API supplies inactivity timing and process isolation semantics; these fixtures do not prove Cloudflare's implementation.
The local Worker and production checks exercise that integration with the real provider runtime.

The Rust recipe test executes the actual Just recipes with recording command adapters.
All seven variadic recipes must preserve spaced values, empty values, Japanese, quotes, substitution syntax, glob characters, and newlines.
Each recipe must propagate the recorded child exit code 23.
The test also exercises the nested service gate and its dependencies without running a deployment or an import.
The original recipe fails this test by splitting a spaced argument and dropping an empty argument.

`npm run e2e:cloudflare` runs fourteen cases through `cf dev`, Vite, workerd, and the Linux image on desktop Chromium and iPhone browser emulation.
It checks snapshot identity, all 47 prefectures and 39 category cells, real search and downloads, source navigation, request protections, HEAD handling, static file hashes, cache validators, fonts, layout, and Axe rules.
No remote account is needed for these local checks.
The Cloudflare build command runs `cf build` and `cf deploy --dry-run --prebuilt` together to check local Build Output without publishing it.
The dry run rejects an explicit cross-Worker Container reference that local runtime tests can otherwise accept.
The production route uses the current Worker's typed loopback namespace instead of declaring an external namespace reference.

Snapshot fixtures reject corrupted archives, output replacement, mismatched manifests, modified database bytes, and startup without the required manifest.
The service image uses read-only root-owned data and a non-root app user.
The local Cloudflare runtime adds Docker capabilities for its networking adapter.
These local results do not establish production capability isolation, billing limits, global availability, load capacity, or account permissions.
Production deployment requires separate verification of account capabilities and public HTTPS behavior.
Physical device imports remain an explicit unverified boundary.

## Device interoperability

VCF files use vCard 3.0, UTF-8, CRLF lines, escaped text values, and folding at 75 octets without splitting UTF-8 characters.
Browser emulation checks web behavior and does not perform a physical iPhone or Android contact import.
Physical device imports have not been exercised by the automated gate.
For a manual check, export a small filtered result, inspect the displayed name, organization, address, and all telephone fields after importing it into a disposable address book, then remove the imported records.
Do not import the entire national directory into a personal account for this check.
