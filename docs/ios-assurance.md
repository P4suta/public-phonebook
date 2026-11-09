# Native assurance boundaries

The project records verification receipts under `target/ios/`.
Receipts bind each verdict to source hashes and reject edits made during execution.
A passing receipt covers its named check, inventory, and target.
Consult the receipt and logs for the candidate's actual results.

## Data and synchronization

TypeScript and Swift consume the same corpus produced by the actual Hono handlers.
Swift imports the provider archive through the real synchronization path and checks its digest, length, snapshot, rows, dictionaries, regions, and counts.
Tests cover cancellation, interrupted imports, SQLite activation, and pinned saved-file digests.
Tests compare the byte parser with the string parser on 20,000 mutated lines.
Synthetic fixtures establish compatibility without establishing the correctness of a particular production publication.

Delta tests rebuild the provider's updated archive from its saved baseline and compare every byte.
They cover admission failures, the complete-archive fallback, and cancellation.
Boundary tests cover header limits, empty targets, canonical dictionary indices, and overflow-safe row slices.
The shared archive buffer tests check the 1 MiB flushing boundary and preservation of pending bytes and the digest after a failed operation.
Bundled-data tests check every declared identity field, damaged bytes, invalid headers, and wrong row counts.
The generator admits the national archive and rejects deliberate changes before comparing each built app with its declaration.
First-run tests cover bundle and listing outcomes, delta reconstruction, fallback, activation, and temporary-file cleanup.
National import throughput and temporary storage on a physical iPhone remain separate measurements.

Loopback tests cover Range resumption, an ignored range, changed identities, invalid Content-Range, a 416 reply, and a cut synchronization.
Worker tests check ranges through workerd and R2, while Dafny checks range arithmetic.
Session tests check connection reuse, cancellation, transfer-origin selection, and the difference between waiting transfers and immediate JSON failures.
They don't establish natural network loss or iOS network-path reporting on a physical device.
Daily update tests check a 304 response, the saved snapshot, and automatic transfers waiting for an inexpensive path.
Person-initiated transfers may use every path.
Background-expiry tests cancel work and observe released transfer and SQLite locks before the expiry handler returns.
Natural background delivery, process suspension, and filesystem durability remain operating-system boundaries.

## Caller identification and memory

The streamed caller merge preserves ascending numbers and lets the controlled QA label replace its matching national entry.
Seeded tests compare streamed merges and differences with independent list models across chunk and batch boundaries.
Applied-state tests check that removals followed by additions produce the target entries.
Malformed preflight input must fail before any CallKit effect.

The load decision limits individual incremental operations to 1,000 and otherwise selects one clear followed by a streamed replacement.
Isolated host tests compare 600,000 caller entries through unchanged, incremental, removal, addition, relabeling, and empty loads.
An independent archive test hashes 100 MiB while measuring process footprint.
The line-size limit applies before the consumer receives either a terminated or an unterminated line.
The decoder uses a managed Data buffer and one owner for initialized C state.
Port tests use [Apple's Compression contract](https://developer.apple.com/documentation/compression/compression_stream_process%28_%3A_%3A%29) to check release after success and failure, finalization flags, input slices, invalid counts, and stalled processing.
Address Sanitizer and Thread Sanitizer run the complete applicable package inventory.
Host process measurements exclude UIKit, the extension process, and CallKit's internal allocations.
Real incoming calls and device memory termination require separate observations.

## Pure decisions and proof scope

Lean checks 72 named theorems and replays generated roots with `leanchecker --fresh`.
The publication model covers arbitrary finite traces under the shared transition contract.
Receive-budget and pagination theorems establish guarded integer bounds and arithmetic safety.
Caller-merge and caller-difference theorems establish ordering, replacement, uniqueness, and the resulting number-to-label map.
Four caller-load theorems establish the combined operation limit, invalid-count fallback, guarded subtraction bounds, and the empty-change decision.
Four decoder theorems establish end detection and rejection of a stalled decode before and after input exhaustion.
Source refinements bind each modeled decision to the corresponding Swift implementation.

Wait-display proofs cover countdown monotonicity, positive estimates, line holding, and the weak-signal choice.
The Lean model replays eleven Swift traces, and native tests cover boundaries and seeded traces.
Update proofs cover the daily read interval, network restrictions, waiting transfers, person-initiated transfers, and unchanged listings.
The update model replays ten Swift traces.
Deliberate defects must fail inside their named theorems rather than through unrelated compiler errors.
The controls include caller changes, operation limits, publication, admission, pagination, waiting, and update decisions.

Proofs establish their formal statements under their assumptions.
They don't establish Unicode behavior, framework contracts, storage durability, network-path accuracy, or the adequacy of a reviewed translation.
Native tests and real device observations cover those separate boundaries.
Neither a proof receipt nor a successful compile proves the entire app.

## Search, interface, and privacy

QA and release builds use the same literal search implementation.
The [retirement decision](adr/keep-qa-search-aligned-with-the-release-app.md) removes the experimental ranking target and companions.
Directory-model tests cover category previews, complete telephone matching, pagination, changed input, and late asynchronous completions.
Controlled reads establish that an older query can't replace a newer result or clear its page operation.
Simulator scenarios cover literal names, metadata, large text, permission states, retry paths, and category continuation.
`mise x -- just ios-search-measure` measures five launches from a saved national generation and three repetitions of four literal queries for memory use.
Simulator performance doesn't establish physical iPhone performance.

Static gates check logging APIs, public-value classifications, required reason APIs, and the app's appearance colors.
Planted violations establish that each scanner detects its promised inputs.
The app and extension use `Logger` according to [Apple's logging guide](https://developer.apple.com/documentation/os/generating-log-messages-from-your-code).
Telephone numbers, labels, queries, and error descriptions never appear as public log values.
Text scanners don't establish the behavior of an SDK, indirect call, or future unrecognized spelling.

Built-property-list checks cover the launch screen and each configuration's selected transport declaration.
Release scans reject experimental search resources and six QA marker strings.
Verification builds must contain all six markers, and a contaminated Release control must fail.
The control plants empty forbidden resources in its own build to check filename detection.
Icon checks bind Figma sources to derived assets and validate SVG boundaries and mask geometry.
Visual meaning, actual device appearance, carrier calls, and natural background delivery remain distinct observations.

## Gate completeness

The fast project gate includes strict TypeScript checks, behavioral tests, dependency checks, secret checks, and workflow checks.
Rust checks add formatting, strict Clippy, native-tool tests, icon consistency, and the pinned RustSec snapshot.
The snapshot excludes newer advisories and registry yank status.
The native unit gate enumerates compiled tests, rejects missing or skipped required work, and checks coverage and strict Swift lints.

The default mutation campaign covers the shipped pure core and extension notification policy.
The affected campaign selects the caller, archive, decoding, directory, synchronization, and storage files changed by the retirement and memory fixes.
The native mutation command accepts `--jobs` from 1 to 4 and defaults to one worker.
Profiles running `PhonebookCoreTests` stay serial because their test processes clean shared per-test directories.
Profiles running `PhonebookKitTests` use the requested worker count.
The runner preserves interrupted plan journals and executes every selected mutant with fresh logs.
Scratch samples include the requested temporary directory and Foundation's shared Swift sandbox directory.
The 4 GiB storage budget uses allocated blocks, and sparse logical capacity has a distinct receipt field.
The [macOS file-status contract](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/stat.2.html) defines allocated blocks in 512-byte units.
Other operating-system temporary files remain outside that measurement.
Receipts distinguish test detection, crashes, narrowly justified equivalents, compiler rejection, survivors, and inconclusive resource stops.
An incomplete inventory, surviving mutant, or timeout supplies no passing campaign result.

`just verification --scope affected <identifier>...` reports named Swift Testing functions to `dotfiles verify run` as structured JSON.
It refuses missing or ambiguous identifiers and treats missing result lines as inconclusive.
The local adapter preserves `just ios-unit-test` as the authoritative native unit gate.

The manual Assurance workflow runs the declared checks on hosted runners.
The TestFlight workflow requires native checks, Lean proofs, sanitizers, and mutation checks before delivery.
No local QA installation grants authority to sign a distribution, upload a build, or publish a release.
Physical-device procedures and recorded limits remain in [device verification](ios-device-verification.md).
