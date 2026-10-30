# Verification contracts

All owned application, API, data tooling, and test implementation is TypeScript.
The previous Rust checks describe the previous implementation and do not verify this one.

## Required fast gate

Run `mise x -- just check`.
It runs strict TypeScript checking, Biome, type-aware Oxlint, deterministic unit and property tests, a complete client and Worker build, dependency auditing, a publishable-file secret scan, workflow validation, and built-browser design checks.
The browser check creates a separate local D1 and R2 fixture and uses port 8790.
It requires no owner-specific service, credentials, or national archive.
CI runs the same command on Linux with pinned tools and immutable action revisions.
Proofs and the national multi-browser campaign remain outside the per-change CI gate.

No owned source may use unchecked assertions, explicit any, floating promises, or unsafe dynamic values.
External inputs are unknown until Valibot validates them.
The generated TanStack route tree is a compiler-output boundary and is excluded from source linting.
External declarations use skipLibCheck; owned adapters and public contracts remain checked.

The deterministic property campaign uses fixed seeds and run counts.
Design-contract checks compare the TypeScript roles with retained Figma style values and variable names.
Built-browser checks enforce the intended upper and lower hierarchy and reject clipped actions when contact text doubles in size.
The retained Figma layout audit checks all four existing pages and preserves a known failing pre-repair canvas arrangement as a negative control.
Native Figma text measurement and browser layout remain external rendering boundaries.
The geometry checks establish properties of the captured records, not all possible layouts or unexported Figma changes.
Browser checks require the API schema URL action to occupy one line at the normal text size.
Contact checks bind related target edges and enforce one primary framed call action per telephone number.
They require number copying to remain separate from calling and preserve alignment after successful and denied copying.
The browser detector must reject deliberately displaced actions and redundant framed navigation with the expected rule names.
It covers Unicode tokenization, name normalization, cursor encoding, vCard byte folding, malformed input, literal SQL metacharacters, region compatibility, and spreadsheet formula guards.
Native Miniflare tests execute the actual API and Drizzle adapter against D1.
Their 173-record fixture checks complete keyset traversal, combined filters, bounded category previews, and independent category continuation without omissions or duplicates.
Planted duplicate categories, foreign-category rows, repeated identities, false totals, and mixed snapshots must fail response validation.
Runtime initialization has a safety deadline rather than a performance assertion.
A timeout supplies no behavioral evidence.

## Source-bound proofs

The staging admission predicate is bound to the outer Worker guard.
Its proof requires all configured origin, token-verification, and identity predicates for staging admission.
Signature validation, key retrieval, Cloudflare Access policy evaluation, and native asset routing cross verifier semantics.
Their checked alternatives are real RSA-signed JWT fixtures, invalid-claim and forged-key controls, method/path boundary tests, native browser checks, provider policy reconciliation, and live anonymous probes.
The trusted public-key endpoint is derived from the configured issuer, never the token header.
Revisit this boundary if Access token semantics, the JWT library, or asset routing changes.

Run `mise x -- just prove`.
LemmaScript 0.6.5 translates the actual annotated search, copy, reference-style, publication, and collection policy implementations to Dafny.
The gate requires unmodified generated output and every function listed in `tools/prove.ts`.
Dafny 4.11.0 checks its expected nonempty unit and postcondition inventory for the supported search, copy, styling, publication, school-evidence, unique-candidate, and source-accounting decisions.
The copy policy partitions current success, current failure, and superseded completion over the full Boolean domain.
The browser adapter uses fresh symbol identities and suppresses superseded state and announcements.
Separate negative controls accept limit 101, reverse the completion guard, reverse the trusted-click guard, and retain reference opacity while retaining their contracts.
Each must fail verification.
A conflicting import identity and a changed staging candidate also have source-mutating negative controls that must fail verification.
Publication controls also drop manifest equality, recovery ownership, pending-resource protection, coverage retention, and initial-candidate ownership.
The production coverage decision admits only validated integer counts within ten million records, keeping its arithmetic within exact JavaScript integer representation.
Collection controls remove name evidence, admit an empty candidate set, and omit duplicate rows from accounting.
Each must fail with an unproved contract rather than a tool error.
A tool error, timeout, missing condition, or empty inventory cannot count as that rejection.

The verifier uses a pinned base-image digest and a checked upstream archive digest.
Each run copies its bound source, configuration, and lockfiles into a read-only input snapshot under `proof/input` before generating any models.
The generator and verifier consume that snapshot, and the gate rejects changed production inputs or model bytes before recording a result.
Each run records the resulting immutable image ID, source and lockfile hashes, input paths, generator configuration, model hashes, expected inventory, and result in `.local/proof-receipt.json`.
`npm run prove -- --check-receipt` rejects stale production sources, copied inputs, generated models, and incomplete contract inventories.
Separate receipt controls alter a copied source and a generated model, require the expected stale-input rejection, restore the original bytes, and check the complete receipt again.
Docker execution has no network, a read-only project mount, a 2 GiB memory limit, no swap allowance, two CPUs, 256 processes, and a 900-second safety stop.
Each condition also has a fixed solver resource limit.
A safety stop is inconclusive.

Boolean decisions use their complete finite domain.
String proofs use JavaScript UTF-16 semantics.
The numeric proof covers integer limits admitted by decimal parsing and integer validation, not arbitrary IEEE-754 values.
JavaScript normalization, UTF-8 codecs, Web Crypto, URL parsing, SQLite, React, browser scheduling, and Cloudflare storage are external semantic boundaries.
Their assessed alternatives are strict boundary validation, fixed seeded properties, native D1 integration, full data reconciliation, and browser fault injection.
Revisit the proof boundary when the translator supports those native operations or the implementation changes those assumptions.
These checks do not prove the complete service or the truth of a publisher's data.

Collection parsers, Unicode normalization, regular expressions, PDF rendering, HTTP transport, and SQLite iterators cross the translator's supported semantics.
The supported evidence-selection and row-accounting decisions are proved under Boolean and validated finite-integer assumptions.
The checked alternatives use planted UTF-8 and Shift-JIS CSV, merged spreadsheets, spanned HTML tables, ambiguous school records, conflicting regions, fax-only fields, cache corruption, rate limits, and incomplete publication inputs.
Address checks include named-place counterexamples and 500 fixed-seed idempotence cases.
The complete data gate rejects a stored address that is not canonical and rejects incomplete or duplicate catalog partitions.
Canonical native preparation also checks the JSONL, CSV, and vCard representations against the same contact contract.
These checks establish the tested representation and boundary behavior, not the truth, recency, or completeness of public directories.
Revisit the alternatives when parser support, numeral rules, collection identity, or translator semantics change.

Telephone formatting depends on the pinned `libphonenumber-js` metadata, Unicode normalization, and JavaScript regular expressions.
Those operations are outside the translator's supported decision semantics.
The checked alternative uses explicit input alphabets, matching source/canonical fields, known numbering examples, 2,000 fixed-seed digit round trips, native D1 queries, and complete snapshot reconciliation.
Unknown metadata never authorizes changing digits or deleting source records.
Revisit this boundary when the translator supports these native operations or the numbering metadata or admitted input domain changes.
The browser tests execute native clipboard writes in addition to mocked success and denial.
The native Chromium success case explicitly grants only clipboard writing for the test origin; WebKit and Firefox use their gesture-based defaults.
Native failure diagnostics retain focus, visibility, user activation, and the browser error without reading clipboard contents.
The [WebKit clipboard contract](https://webkit.org/blog/10855/async-clipboard-api/) requires a secure context and a user gesture.
A [reported WebKit regression](https://bugs.webkit.org/show_bug.cgi?id=324512) consumes real transient activation during JavaScript evaluation around a click.
The compatibility adapter chooses synchronous selection copying for a trusted click with unavailable activation or an absent asynchronous clipboard API.
The deprecated selection-copy command remains isolated in that adapter and is not a fallback for an explicit asynchronous clipboard denial.
Native fault injection consumes activation with a popup before React receives the first click and checks the actual selection-copy event rather than a replacement clipboard implementation.
WebKit must copy on that first click.
Chromium and Firefox reject that native write after popup activation loss; their cases require readable failure followed by successful copying on the next trusted click.
An additional case removes the asynchronous API and checks native copying of an API URL.
Untrusted synthetic clicks must leave both write paths untouched.
These checks cover DOM events, focus, and browser behavior through native tests rather than translator proofs.
Headless WebKit evidence does not certify every released Safari build or its native data detectors.

Category previews use a parameterized SQLite window query over narrow sortable columns and retrieve payloads only for the selected previews.
Native D1 tests cover ranking, counts, limits, category partitions, and complete traversal through the unchanged cursor contract.
The annotated preview-size function proves the one-through-three bound over all validated integer page sizes.
The translator does not model SQLite query execution, normalized-name comparison, React caches, or browser layout.
The checked alternatives are native database integration, schema rejection controls, and multi-browser grouped-result and no-JavaScript tests.
Revisit this boundary when those semantics become supported or the query, cache identity, ranking, or continuation contract changes.

## National data and browser campaign

Prepare and seed the national bundle as described in [local operation](deployment.md).
Run `npm run data:check -- .local/phonebook` to verify every retained contact, source reference, sortable field, index column, category and prefecture count, phone relation count, search index count, archive byte length, SHA-256, and SQLite integrity.
The original publication is opened read-only.
The active retained snapshot has 667,696 contacts, 561,495 distinct telephone numbers, 1,179 sources, 62 populated categories, and 47 prefectures.
The data audit identifies the exact snapshot in its output.
Run `npm run data:phones -- .local/phonebook .local/phone-quality.json` for the source-bound telephone profile and complete metadata review queue.
The earlier archived publication had 651,500 contact/phone relations, including 12,693 unseparated spellings and 11,326 spellings containing non-ASCII characters.
Its common display formatter changed 36,527 source spellings without changing their canonical digits.
Its audit found 160 relations outside the pinned full metadata's recognized patterns.
They require source investigation and are preserved without speculative digit repairs.
The audit requires zero unparseable spellings, source/canonical disagreements, formatting round-trip disagreements, and duplicate numbers within a contact.

Run `mise x -- just test` for the fast gate, national data reconciliation and phone profile, complete proof inventory, and national browser campaign.
The command invalidates its preceding test receipt before execution and records a replacement only for an unchanged clean Git tree and dataset manifest.
Production rejects a receipt for another dataset, source tree, format, or incomplete result.
Dirty development checkouts can run the same checks but produce no publication receipt.
The publisher separately checks the proof receipt and the active staging publication.
The browser campaign uses built client and Worker output.
It covers automatic search, Japanese composition, early input, dependent regions, exact-name ranking, call/map/detail/source actions, denied clipboard access, native no-JavaScript continuation, retries, changed snapshots, untrusted result text, local assets, nonce handling, HTTP contracts, and complete-download hashes.
It also queries every prefecture and category against native D1.
Browser failures retain screenshots, videos, traces, and structured diagnostics under `test-results`.
Design cases retain native video even on success.
WebKit uses native video instead of Playwright screenshots because its screenshot synchronizer injects a stylesheet that violates CSP.
The console and CSP gates remain enabled, and no context bypasses CSP.
The [native-select compatibility decision](adr/hashed-native-select-style-compatibility.md) records the search-page style-attribute hash and its positive and negative controls.
The [interactive reference decision](adr/openapi-driven-interactive-reference.md) records the separate API-page style policy, dependency configuration, and rendering boundaries.
Generated-reference tests compare the operation list with the live OpenAPI document, send successful and invalid requests, inspect native responses, search with the keyboard, and check failure recovery.
Recovery includes failed background refreshes after a simulated reconnect with a controlled clock.
Client checks require visible close and checkbox controls, distinct checkbox states, and checkbox cells that contain their touch targets without overlapping adjacent fields.
They also exercise native code copying, direct operation links and reload, JavaScript-free access to the raw contract, and deferred loading of the reference bundle.
The reference adapter preserves native button semantics, labels read-only response editors, exposes collapsed combobox state, and restores keyboard access to response scrolling.
The palette gate covers CSS and SVG opacity as well as masks, gradients, shadows, filters, blending, and paint colors.
Its negative controls run inside the live reference page as well as isolated fixtures.
CSV fixtures independently parse serializer output and cover embedded commas, quotes, newlines, empty values, and all six guarded formula prefixes.
Publication fixtures use native D1 batches to lose a response after commit, resume from its checkpoint, preserve every bound value, and roll back both records and checkpoints after an invalid batch.
The same proven one-through-one-hundred bound guards SQL parameter counts.
Remote SQL execution, provider transactions, archive storage, and HTTPS delivery remain external semantic boundaries.
Their checked alternatives are native transaction controls, source-bound import receipts, remote reconciliation, and the public browser and complete-download gate.
Revisit these boundaries if the provider protocol, import schema, or verifier support changes.
The HTML report is under `playwright-report/native`.
Do not edit or rebuild the served application while this campaign runs.

Physical-device contact import, assistive-technology review, production provisioning, real traffic capacity, provider freshness, and telephone reachability remain outside these local checks.
No local result establishes production readiness or authorizes deployment.
