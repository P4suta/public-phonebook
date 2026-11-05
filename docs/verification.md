# Verification contracts

All owned application, API, data tooling, and test implementation is TypeScript.
The previous Rust checks describe the previous implementation and do not verify this one.

## Required fast gate

Run `mise x -- just check`.
It runs strict TypeScript checking, Biome, type-aware Oxlint, and deterministic unit and property tests.
It also runs npm dependency auditing, a publishable-file secret scan, and workflow checks.
Its verdict needs no build, Rust toolchain, browser, container, or macOS host.
It requires no owner-specific service, credentials, or national archive.
Its final JSON line lists every step's milliseconds, retired instructions, coverage, and work counters, and a table on standard error repeats the time and instructions.
On macOS the gate builds `step-meter` from the `tools/ios-check` workspace and runs each command as the meter's direct child.
The kernel's count for a process covers the programs it execs, but not the processes it forks.
A step is `complete` only when no measured process reaped a descendant or handed its work to a container.
Otherwise the step is `partial`, and its `gaps` name the left-out work, such as `npm: forked processes`.
Without the meter, as on Linux, every step is `unmeasured`.
These numbers only report where the work goes, and no verdict reads them.

Before every push, run `mise x -- just check-linux` as well.
It's the local equivalent of the Verify job, as the [Linux gate](#linux-equivalent-of-verify) section describes.
Before pushing a change to the build or the browser checks, also run `mise x -- just check-build`, because pull requests don't run it.
Before pushing a change to a Rust input, run `mise x -- just check-rust`, the Cargo part of `just check-build`.

The workflow checks run actionlint over every workflow and zizmor offline with the pedantic persona over `.github`.
Offline mode leaves out zizmor's online audits, so the result doesn't depend on network access or a token.
The typed policy in `tools/workflow-policy.ts` also checks every workflow and local composite action.
It requires explicit permissions on every workflow and job, and every top-level block must be empty.
It allows only `actions/checkout`, `actions/cache`, `actions/upload-artifact`, `actions/download-artifact`, `dopplerhq/secrets-fetch-action`, `jdx/mise-action`, `actions/attest-build-provenance`, and `actions/attest`, each pinned to a full commit SHA.
It rejects `inputs` or `github.event` expressions inside a `run:` script, which must receive those values through `env:`.
It admits `id-token: write` only in a job that names an environment or calls a reusable workflow.
A workflow with such a job may start only from `workflow_dispatch` or `workflow_call`.
A workflow that `pull_request`, `pull_request_target`, `merge_group`, or `push` triggers is a change workflow.
Each of its jobs must name a literal `ubuntu-` runner.
No job may run `just assurance`, `just check-build`, `just prove`, `just e2e`, `just test`, or a `just ios-` recipe.
No job may install Playwright browsers or call `assurance.yml` either.
The `Checks` job of a change workflow must run with `if: always()` and need every other job.
The policy evaluates its result checks over every combination of job results and scope outputs.
They may accept only `success`, except that they may also accept `skipped` from the `rust` job.
The policy rejects a check script outside its `test` grammar, a custom shell, and `continue-on-error` in that job.
Its unit tests keep a violating workflow for every rule as a negative control.

Pull requests and merge groups run this fast gate, plus the Cargo checks when a Rust input changes.
The Verify job of the Checks workflow runs `just check` on Linux with pinned tools, immutable action revisions, and no secrets.
It installs only Node.js, just, Biome, actionlint, zizmor, and gitleaks, and it turns off mise's automatic installation of the other pinned tools.
Beside it, the Scope job lists the files that differ between the event's base commit and the checked-out head.
The Rust inputs are `tools/ios-check`, `tools/check-rust.ts`, `mise.toml`, any `rust-toolchain` file, the toolchain action, and `checks.yml`.
When one of them changed, the Rust job runs alongside Verify.
It installs Rust, just, Node.js, and the prebuilt cargo-audit release and runs `just check-rust`.
mise checks that release against the SHA-256 that `mise.toml` pins for each platform.
The `Checks` summary job is the required status check.
It requires Scope and Verify to succeed, and it accepts a skipped Rust job only when no Rust input changed.
The [release gate decision](adr/run-only-the-fast-gate-on-pull-requests-and-verify-at-the-release-gate.md) records why the heavier checks moved.
The manual runner probe workflow reports the processor, memory, disk, Xcode versions, and simulators of the hosted runners.

## Release assurance

Run `mise x -- just assurance` on a Mac for the heavy checks that gate a release.
It runs `just check-build`, `just prove`, `just ios-prove`, and `just ios-check` in that order.
`just check-build` builds the client and Worker and checks the `tools/ios-check` crate.
The crate checks are rustfmt, strict Clippy, its tests, the icon consistency check, and the pinned RustSec advisory snapshot.
`just check-rust` runs the same crate checks alone.
It then runs the built-browser checks.
The browser check creates a separate local D1 and R2 fixture with three contacts and uses port 8790.
It covers the design, contact, external-link, information, CSP, privacy, row page, local search, search, search-trigger, and startup cases that need no national archive.
It requires no owner-specific service, credentials, or national archive.

The manual Assurance workflow, `assurance.yml`, runs the same set on hosted runners.
Its build job runs `just check-build`, and its formal job runs `just prove` and `just ios-prove`.
Its native job runs `just ios-check` on the `xcode-27` runner.
A failed or cancelled native job uploads `target/ios` with the [evidence of each failed UI scenario](ios.md) as a seven-day artifact.
The `campaigns` input adds the sanitizer and mutation campaigns to the native job.
`candidate.yml` calls it through `workflow_call` for each release candidate.
No pull request, merge group, or push starts it, and a manual run gates nothing by itself.
The national multi-browser campaign stays out of it and runs in `just test`.
The manual TestFlight workflow reruns the native, Lean, sanitizer, and mutation checks for one `main` commit before its signed delivery.

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
Contact checks bind related target edges and enforce one primary framed call action per telephone number.
They require each number to stay plain text apart from its call action, and they reject any button in a result card.
The browser detector must reject deliberately displaced actions and redundant framed navigation with the expected rule names.
It covers Unicode tokenization, name normalization, cursor encoding, vCard byte folding, malformed input, literal SQL metacharacters, region compatibility, and spreadsheet formula guards.
The external-link confirmation decision is checked over all 32 combinations of its five Boolean inputs and isn't part of the proof inventory.
Native Miniflare tests execute the actual API and Drizzle adapter against D1.
Their 173-record fixture checks complete keyset traversal, combined filters, bounded category previews, and independent category continuation without omissions or duplicates.
Those tests run the API in Node, which ignores a response's body encoding mode.
A separate test bundles the API module into workerd and reads the raw HTTP response without decoding it.
It requires the stored Brotli bytes of the search index with `Content-Encoding: br`, and fails when the runtime encodes the body again.
The built-browser checks serve the built Worker with `npm run preview`, which runs it in workerd behind workerd's own HTTPS socket.
The Vite preview relayed each response through Node's fetch, which decoded the Brotli index but kept its encoded length, so the browser received a corrupted index.
WebKit advertises Brotli only over HTTPS, so the server uses Miniflare's loopback certificate, and the browser contexts ignore its certificate errors.
The server log then reports a failed TLS handshake for each rejected certificate check, which doesn't affect the run.
The browser checks load the index in every engine, compare results before and after the switch, and fall back when the published digest doesn't match.
After the index loads, they require no `/api/contact*` request and no request that carries the search term, and they search offline.
They also check save-data skipping, the changed-snapshot reload, old URL redirects, and the absence of IndexedDB, Service Worker, and Cache Storage data.
Worker unit tests check the loading progress, the replacement of a stale index, and the fallback after a failed replacement.
Planted duplicate categories, foreign-category rows, repeated identities, false totals, and mixed snapshots must fail response validation.
Runtime initialization has a safety deadline rather than a performance assertion.
A timeout supplies no behavioral evidence.

## Linux equivalent of Verify

The Verify job runs `just check` on `ubuntu-24.04`, and `just check` on macOS can't show Linux differences.
The provider corpus once changed only on Linux, because macOS and Linux write a different operating system byte into gzip headers.
Run `mise x -- just check-linux` before every push to run Verify's `just check` in a pinned Linux container.

The command builds `verification/linux/Dockerfile`, or reuses its cached layers.
The image starts from the digest-pinned Playwright image for the locked Playwright release.
That image is Ubuntu 24.04 with the matching Chromium build and its system libraries.
It adds mise at the toolchain action's version and installs the `mise.toml` toolchain.
It also adds pinned ShellCheck 0.9.0, which the hosted runner provides and actionlint uses for `run:` scripts.
A pinned C compiler and C library headers let Cargo link.
The tool refuses to start when the image's Playwright release differs from `package-lock.json` or its mise differs from the toolchain action.

The checkout is mounted read-only.
The container copies the publishable files, the inventory the secret scan uses, into a fresh Linux tree and indexes them in a new Git repository.
It then runs `npm ci --ignore-scripts` and `just check` with `CI=true`, like the Verify job.
Named volumes keep the npm cache, the Cargo registry, and `tools/ios-check/target`.
The macOS `node_modules`, Cargo target, and test outputs never enter the container's tree.

The container gets four CPUs, 8 GiB of memory without swap, 4,096 processes, 1 GiB of shared memory, and a 3,600-second safety stop.
The hosted runner has four CPUs and 16 GiB of memory.
A memory kill or a safety stop is inconclusive, never a pass or a failure.
The command doesn't use `dotfiles bounded run`, because `just check` runs none of the bounded tools.
The bounded policy's 2 GiB, two-CPU, offline envelope also can't run Verify.

The run needs the network.
The image build fetches the base images, the Ubuntu packages, and the mise toolchain.
`npm ci` fetches the locked npm packages, including the SheetJS tarball.
`just check` itself queries the npm advisory service for `npm audit`.
The Verify job fetches the same data.

The command exits with the container's status.
It writes `receipt.json`, `output.log`, and a container record with phase times and peak memory under `.local/check-linux/verify/`.
After a failure, the same directory keeps the container's `test-results`.

The container runs `linux/arm64` on the Mac, while the Verify job runs `linux/amd64`.
The native npm packages for esbuild, Rolldown, Lightning CSS, Oxlint, the TypeScript compiler, and workerd differ by architecture.
A difference that depends on the processor rather than the operating system can still reach CI first.
The gzip header byte depends on the operating system, so this gate catches it.

`mise x -- just check-linux --control` keeps that case as a negative control.
It removes the gzip header normalization from a copy of the provider fixture and regenerates the corpus on macOS, which must accept it.
The unchanged corpus must then pass in the container, and the planted copy must fail the corpus assertion there.
The control records its result in `.local/check-linux/control/receipt.json`.

## Source-bound proofs

The release decisions `promotionAdmission` and `withdrawalDecision` gate the in-place candidate lifecycle in `tools/release-lifecycle.ts`.
Promotion requires a verified candidate whose version ID is still deployed at 0% while the current version is still the verified predecessor.
Withdrawal removes only the candidate that the journal's release owns, and only while the predecessor serves and no traffic has moved.
Cloudflare's version routing, the override header, the deployment API, and the zone's rate limit cross verifier semantics.
Their checked alternatives are fake-provider tests of staging, withdrawal, promotion, rollback, and the withdrawal drill through the same lifecycle and provider code.
Each public check refuses a response whose `x-dial-version` names another version, and unit tests cover the request budget and the refused Worker-wide settings.
`probeHold` proves that the budget holds a refused request for more than 0 and at most one probe window, and the public checks' waits derive from that bound.
The budget clamps a request time from a faster clock to the current time, so the proof's precondition holds for every ledger.
`just public-rehearsal BUNDLE` runs the same public checks on the built preview with the same budget, so only the override and production's network wait for a workflow.
Revisit this boundary if Cloudflare changes version overrides, gradual deployments, or the Worker and version API responses.

Run `mise x -- just prove`.
LemmaScript 0.6.5 translates the actual annotated search, search-trigger, site request, publication, collection, snapshot, row locator, and directory delta policy implementations to Dafny.
The gate requires unmodified generated output and every function listed in `tools/prove.ts`.
Dafny 4.11.0 checks its expected nonempty unit and postcondition inventory for the supported search, search-trigger, site request, publication, school-evidence, unique-candidate, source-accounting, versioned-API snapshot, and row locator decisions.
The site request policy refuses a site-route request exactly when its `Sec-Fetch-Site` header is present and differs from `same-origin`, over the full Boolean domain.
It also admits search page sizes from 1 through 30, the page size that the site requests.
Separate negative controls accept limit 101, ignore a municipality when choosing a catalog total, store a failure status, admit a site-route request from another site, and accept a 31-row site page while retaining their contracts.
Each must fail verification.
Search-trigger controls ignore composition, search an incomplete telephone number, and pause after one keystroke interval, and each must fail verification too.
The word rank decision proves that a row matches exactly when every word occurs in its name or its region or category, and that region and category matches rank after every name match.
Its control ranks a region or category match with the name matches and must fail verification.
Fixed-seed property tests compare the word splitting, the folding, and the match-and-rank decision with a plain reference on both platforms.
The shared search contract also lists the number that the website reads from each of 429 telephone spellings, or none.
They cover hyphens, full-width digits, parentheses, `+81`, edge whitespace, and altered spellings that stay word queries.
A website test compares each reading with a plain restatement of the rule, and the iPhone app's tests require the same reading.
`mise x -- just check` requires, without the network, that both kanji variant tables carry the same pairs under the pinned provenance.
It also requires the committed 364 traditional forms of the Joyo Kanji Table to sit beside 362 standard characters and to fold into them through the table.
`mise x -- just check-build` fetches the pinned Unihan archive and the pinned Joyo Kanji Table notice, verifies their SHA-256 digests, regenerates both tables and the traditional forms, and requires the committed bytes.
The regeneration requires the notice's 2136 characters to equal Unihan's kJoyoKanji list and its traditional forms to equal both kJapaneseNewVariant and kJapaneseOldVariant.
Both platforms' tests fold every table entry to a representative that folding keeps.
`node tools/search-form-parity.ts ARCHIVE FORMS` writes the website's comparison form of every name in a directory archive.
`BundledAdmission --search-forms FORMS` then requires the app's form to equal it for every name, and `mise x -- just ios-check` runs both for the national and fixture archives that it bundles.
D1 and the browser index derive their forms from the same TypeScript function, and the data check requires each D1 row's `folded_name` to equal it.
A conflicting import identity also has a source-mutating negative control that must fail verification.
The database verification decision scans a database in full only when it has no evidence and no Worker version binds it.
Its controls let a bound database reach the full verification and accept evidence for another import identity.
The target binding decision lets a release target bind only the D1 database whose ID its Worker version holds.
The target vouches for that database only after the release tools prepared and staged it for the same dataset.
Its control binds a database of the same dataset under another ID and must fail verification.
Publication controls also promote an unverified candidate, ignore a changed current version, ignore a different candidate version, and withdraw a foreign candidate.
Further controls drop recovery ownership, pending-resource protection, coverage retention, lease expiry, and the evidence signer.
The production coverage decision admits only validated integer counts within ten million records, keeping its arithmetic within exact JavaScript integer representation.
Collection controls remove name evidence, admit an empty candidate set, and omit duplicate rows from accounting.
The snapshot control admits a supplied snapshot that differs from the active dataset.
The row locator decision partitions malformed input, a stale snapshot, a missing row, and a located row, and places a located row's D1 rowid within the contact count.
Its controls locate the row equal to the contact count and skip the snapshot check.
The directory delta decisions bound each copy inside the base, publish a delta only at half the complete archive or less, and admit a rebuilt archive only when every check holds.
Their controls admit a delta as large as the archive, a copy one row past the base, and a result without a digest match.
Each must fail with an unproved contract rather than a tool error.
A tool error, timeout, exhausted resource limit, missing condition, or empty inventory cannot count as that rejection.

The verifier uses a pinned base-image digest and a checked upstream archive digest.
It installs `unzip` from the Debian package file that snapshot.debian.org serves under its SHA-1, and the build checks that file's SHA-256.
The Lean image for `just ios-prove` gets `zstd` the same way, so neither verifier image reads the live Debian mirrors.
Lean runs with no network, so its image carries no CA certificates.
Each run copies its bound source, configuration, and lockfiles into a read-only input snapshot under `proof/input` before generating any models.
The generator reads a per-run copy of that snapshot in a new temporary directory outside the checkout, so the TypeScript project it builds finds no installed packages.
Before generating, the gate requires every proof source to type-check with only the snapshot and the ES2023 library.
The pinned type packages only add members to `ErrorConstructor` and `ImportMeta` among ES2023 declarations, so the copy translates such a source exactly as the checkout would.
A control requires that check to refuse a planted package import and a planted ambient type.
The generated models and negative sources return to the snapshot, the verifier consumes it, and the gate rejects changed production inputs or model bytes before recording a result.
Each run records the resulting immutable image ID, source and lockfile hashes, input paths, generator configuration, model hashes, expected inventory, and result in `.local/proof-receipt.json`.
`npm run prove -- --check-receipt` rejects stale production sources, copied inputs, generated models, and incomplete contract inventories.
Separate receipt controls alter a copied source and a generated model, require the expected stale-input rejection, restore the original bytes, and check the complete receipt again.
Only after every negative and receipt control passes does the run add the Node.js version and the SHA-256 of npm's installed package record to the receipt.
A later `just prove` reuses that result only while every bound source, input copy, and model keeps its recorded SHA-256.
The verifier image ID, the Node.js version, and the package record must match too.
The image build omits a provenance attestation, so an unchanged cached build keeps its image ID.
Any difference, a missing receipt, or a receipt from an unfinished run starts the complete proof with every negative and receipt control.
A reused result starts no verifier container and runs no negative control, because no proof runs.
A failed run removes the receipt, and deleting `.local/proof-receipt.json` forces a complete run.
Each workflow job starts from a fresh checkout without receipts, so its proof always runs in full.
The final JSON line reports `verified` with the reason and the negative-control count for a complete run, or `reused`, and the step record that the fast gate describes.
Its work counters list model generations, image builds, container starts, Dafny processes, and the solver resource units from the CSV log that each Dafny run writes to standard output.
A complete run starts one Docker container with no network, a read-only project mount, a 2 GiB memory limit, no swap allowance, two CPUs, 256 processes, and a 900-second safety stop.
It runs the positive proof, then each negative control as its own Dafny process, two at a time to match its CPUs.
Each control keeps its own exit status, output, and expected failure check, and a failure names the control.
Each condition has a fixed solver resource limit and no time limit, so a slow or emulated host reaches the same verdict.
A Dafny run that the safety stop ends prints no summary, and the gate reports it as inconclusive.

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

The search-trigger proof covers its decision over every input class, event, composition state, telephone completeness, and integer interval count.
Script classification uses Unicode script-extension regular expressions, telephone completeness reuses the server's telephone normalization, and the pause uses the median of floating-point keystroke intervals.
Those operations cross the translator's semantics.
Their checked alternatives are unit tests for the input classes, complete and partial telephone lengths, and the pause rule, and browser checks that drive typing with a controlled clock.
Revisit this boundary when the translator supports these operations or the trigger rules change.

Telephone formatting depends on the pinned `libphonenumber-js` metadata, Unicode normalization, and JavaScript regular expressions.
Those operations are outside the translator's supported decision semantics.
The checked alternative uses explicit input alphabets, matching source/canonical fields, known numbering examples, 2,000 fixed-seed digit round trips, native D1 queries, and complete snapshot reconciliation.
Unknown metadata never authorizes changing digits or deleting source records.
Revisit this boundary when the translator supports these native operations or the numbering metadata or admitted input domain changes.
Telephone numbers render as plain selectable text, and the site draws no copy control, so no clipboard adapter remains to verify.
Headless WebKit evidence does not certify every released Safari build or its native data detectors.

Category previews with a name, telephone, or region term use a parameterized SQLite window query over narrow sortable columns and retrieve payloads only for the selected previews.
Unfiltered previews read up to three rows per populated catalog category from the category index and take each total from the catalog.
Native D1 tests cover ranking, counts, limits, category partitions, and complete traversal through the unchanged cursor contract.
The annotated preview-size function proves the one-through-three bound over all validated integer page sizes.
The translator does not model SQLite query execution, normalized-name comparison, React caches, or browser layout.
The checked alternatives are native database integration, schema rejection controls, and multi-browser grouped-result and no-JavaScript tests.
Revisit this boundary when those semantics become supported or the query, cache identity, ranking, or continuation contract changes.

Searches without a name term order by normalized name and stable ID and continue with a row-value comparison, as the [broad search decision](adr/index-ordered-broad-searches-with-dataset-bound-caching.md) records.
The annotated total-source function proves that a catalog total is used only for the complete directory, one prefecture, or one category.
That equality relies on the catalog partition that the national data gate checks; the translator does not model the catalog or SQLite counting.
Native D1 tests require 121 broad search, preview, and vCard responses to match the bytes of the window-ranked implementation, and require pre-change cursors to reach the same next pages.
A further test replaces catalog counts and requires exactly the catalog scopes to report them.
A query-plan test runs `EXPLAIN QUERY PLAN` on the generated SQL in local D1 without statistics.
It requires the name and category indexes without a sort and requires the constant-rank ordering to fall back to a sort as its negative control.
The annotated cache-admission function proves that only status 200 is stored.
Native cache tests use an injected cache and an empty database to show hits without database access, separation by dataset digest, and refusal to store 400, 409, and 503 problems.
The Cloudflare Cache API and its per-location storage remain external boundaries checked only through that injected port.
Local plans and timings do not establish D1 latency or production capacity.

## Release workflow policy and pipeline controls

The workflow policy in `tools/workflow-policy.ts` also checks the release workflows.
A job in the `candidate`, `release-candidate`, `observe`, or `production` environment must start with the `main` branch guard.
A `production` job must follow another job, so the owner approves only after the candidate check.
Jobs in `release-candidate` and `production` must share the non-cancelling `publication-production` concurrency group.
A Doppler step must keep its secrets out of the job environment and fetch `ci_` plus its own environment's name.
Only a step that continues on error may request another environment's config.
The unit tests keep a violating fixture for each rule.

`tools/workflow-schedule.ts` models how GitHub schedules jobs: `needs`, job conditions, the status functions, the implicit `success()`, and skips that propagate through ancestors.
For the release, recovery, candidate, and pipeline control workflows, the policy visits every dispatch input value, every outcome of every job that runs, and both values of each unknown output predicate.
In every such scenario it checks declared properties, such as promotion only after a verified stage and withdrawal exactly when a staged candidate's checks fail.
For each input value it also requires the jobs that a fully successful run reaches.
This exhaustive check covers the model's whole finite domain, so it decides those properties for the model rather than sampling them.
The model's fidelity to GitHub is a trust boundary, which the unit tests check against release runs 41599950592 and 41600886131.
The tests also plant a defect in each workflow and require the property that it breaks to fail.
A condition outside the supported grammar fails the policy, so a new construct needs a model first.

`pipeline-controls.yml` fails unless each refusal happens for its expected reason.
- The fake-provider tests refuse an unverified, displaced, removed, or different candidate, a second lease holder, and evidence from another tree, manifest, or signer.
- The observe identity exchanges its GitHub token with Doppler and requests the `ci_production` config, and the step requires a 403 answer that carries a Doppler error message.
  A failed exchange, a network failure, another status, or an answer without that message fails the control, and a successful read fails it without printing the secrets.
- The read-only token tries to deploy a version that doesn't exist, and the step requires an authorization refusal rather than a missing-version error.
- The withdrawal drill stages an attested build at 0%, runs the real candidate checks, injects a probe failure, and requires the withdrawal to leave production unchanged.

The drill and the two token controls need the owner's Cloudflare tokens and Doppler configs, so they haven't run yet.
The authorization refusal's exact message is an assumption about the Cloudflare API, and the first run confirms it.
Doppler documents no status for a config outside an identity's access, so the 403 that the foreign-secret control requires is also an assumption that the first run confirms.

## Release record

`tools/release-record.ts` builds and checks each production release record.
The SBOM lists every locked production package once, by purl, with its license expression and its integrity digest in hexadecimal.
It refuses a package without a version, license, or supported integrity, an SBOM for another product, and one that lacks a direct production dependency.
`SHA256SUMS` has one sorted line per asset, and verification refuses a malformed or repeated line, a missing or extra asset, and a changed byte.
The evidence needs a verified release built from the checked-out tree, admitted evidence for every candidate stage, and a `production` approval without a rejection.
Unit tests cover each refusal, the release tag, and a complete record assembled from a file-backed control store.

The workflow verifies the provenance and SBOM attestations before it keeps their bundles, and it publishes only a draft whose downloaded bytes match `SHA256SUMS`.
`just release-verify` repeats those checks for anyone who downloads a published release.
Provenance shows which workflow, ref, and commit built the tarball, not that the source is correct.
The SBOM lists the locked production dependencies rather than the modules that the bundler kept, and its attestation binds that list to the tarball without proving it complete.
Immutable Releases and the `v*` tag ruleset are repository settings that only the owner can change, so the tests can't establish them.

## National data and browser campaign

Prepare and seed the national bundle as described in [local operation](deployment.md).
Run `npm run data:check -- .local/phonebook` to verify every retained contact, source reference, sortable field, index column, category and prefecture count, phone relation count, search index count, archive byte length, SHA-256, and SQLite integrity.
In a clean checkout, a repeated check of unchanged files reuses the passing result that [local operation](deployment.md) describes.
The same check confirms that row numbers follow the normalized name and identifier order.
It reads the JSON Lines, CSV, and vCard archives in step and requires the same telephone numbers, in the same order, for every contact.
Only the adoption of an earlier production bundle admits that publication's apostrophe before each CSV telephone cell.
It rebuilds `search-index.br` from the database in row order, requires identical bytes, and rejects a compressed index above 8 MiB.
For each directory delta, it checks both digests and lengths, the size rule, the base it names, and the rebuilt archive's identity and header line.
It also compares every literal row with the archive row at its position and requires the instructions to cover every row.
The bundle doesn't hold the base, so the check can't read copied rows; preparation applies each delta to its base and requires identical bytes before it records the delta.
Fixed-seed properties over generated pairs, including renumbered dictionaries and recollections, require the same exact reconstruction.
The original publication is opened read-only.
The active retained snapshot has 667,696 contacts, 561,495 distinct telephone numbers, 1,179 sources, 62 populated categories, and 47 prefectures.
The data audit identifies the exact snapshot in its output.
Run `npm run data:phones -- .local/phonebook .local/phone-quality.json` for the source-bound telephone profile and complete metadata review queue.
The earlier archived publication had 651,500 contact/phone relations, including 12,693 unseparated spellings and 11,326 spellings containing non-ASCII characters.
Its common display formatter changed 36,527 source spellings without changing their canonical digits.
Its audit found 160 relations outside the pinned full metadata's recognized patterns.
They require source investigation and are preserved without speculative digit repairs.
The audit requires zero unparseable spellings, source/canonical disagreements, formatting round-trip disagreements, and duplicate numbers within a contact.

The release gate checks the build and the device search with these entry points, and the candidate stages below call them.
Run `mise x -- node tools/build-budget.ts` after a build.
It requires the gzip size of the Worker's modules to stay under 1 MiB, well below Cloudflare's compressed upload limit, so an accidental bundle fails here first.
It also requires exactly one search Worker script of at most 34 KiB.
The national browser campaign keeps the search page's own scripts within 232 KiB transferred and 736 KiB decoded before the index loads.
On November 2, 2026, the Worker's modules measured 463,097 bytes compressed, the search Worker script 27,152 bytes, and the search page's scripts 185,459 bytes transferred and 589,343 bytes decoded.
The script limits sit about a quarter above those sizes.

Run `mise x -- node tools/search-parity.ts BUNDLE` after `mise x -- just data-local BUNDLE` seeds the same bundle.
It loads the bundle's index through the service that the browser Worker runs, with its admission checks.
It asks the actual API against the seeded D1 for the same queries.
A fixed seed draws 2,000 substrings and 1,000 display names from the index, 1,000 listed telephone numbers, and 200 valid numbers that no contact lists.
The listed numbers take turns among five spellings: formatted, bare digits, full-width, parenthesized, and `+81`.
Every one of them must read as a complete number and find at least one contact.
It also draws 500 queries that pair the start of a name with its municipality, prefecture, or category label.
Each query compares the total, the category order, each category's count, and each preview row's contact ID, name, category, region, numbers, and whether its details show an address.
For the first category of 4 to 100 rows, it also compares the complete ordered category.
It checks 100 row positions with the row locator, the lookup that opens a device result's details.
The run fails on any difference.
Each D1 statement opens a loopback connection from Node to workerd, and macOS keeps a closed one for 30 seconds within 16,384 ephemeral ports.
A read that fails with `EADDRNOTAVAIL` therefore waits a second and runs again, up to 60 times, while any other error fails the run at once.
It also requires two controls to differ: previews with their first two rows swapped, and an index whose adjacent same-name rows with different details are swapped.
It writes `.local/search-parity.json`.

Run `mise x -- node tools/search-performance.ts BUNDLE` with the build and the seeded state to record the device search's performance in `.local/search-performance.json`.
It serves the build like the browser campaign, and runs Chromium with 4x CPU throttling, desktop WebKit, and the iPhone 13 profile.
It records the transferred index bytes, the time until the index is ready, and the p50 and p95 of the Worker's search round trip for 40 queries.
It also records input events of 16 ms or longer while typing, long tasks in Chromium, and the main-thread heap in Chromium.
It estimates the decoded index's heap in V8 from Node, because browsers expose a Worker's heap only to cross-origin isolated pages.
Safari on a physical iPhone and the Worker's own heap need a person and a debugger, so the record lists them as not run.
The record also holds counts that depend only on the build, the dataset, and the fixed query sample, so they repeat on any machine.
Node runs the production matcher over the decoded index for the 40 queries and for each prefix of the typed text, and counts the index rows it reads and the rows it matches.
Each browser profile counts the search messages posted to the Worker during the 40 queries, the result messages it returns, and the UTF-8 bytes of their JSON.
An optimization of the device search is judged by these counts, and the timings stay observations.
The record holds measurements, not thresholds.

Run `mise x -- just test` for the fast gate, national data reconciliation and phone profile, complete proof inventory, and national browser campaign.
The command invalidates its preceding test receipt before execution and records a replacement only for an unchanged clean Git tree and dataset manifest.
Production rejects a receipt for another dataset, source tree, format, or incomplete result.
Dirty development checkouts can run the same checks but produce no publication receipt.
Production admits a candidate on candidate evidence from `candidate.yml` rather than on a local receipt.
The candidate stages run in this order: `check`, `data`, `parity`, `phones`, `prove`, `e2e`, `ios-prove`, and `ios-check`.
Each stage's evidence binds to the files it reads, as the [stage inputs decision](adr/bind-candidate-evidence-to-the-files-each-stage-reads.md) records.
Production requires passing evidence for every stage, so evidence without `parity` is refused as a missing stage.
The `check` stage runs the build checks after the fast gate, and then the build budget.
The `parity` stage runs the search parity comparison on the candidate's dataset, which the workflow seeds into the local D1 first.
The `e2e` stage runs the national browser campaign in Chromium, Firefox, WebKit, and the mobile WebKit profile, including the script budget in `budget.spec.ts`.
After a complete run, the command records the search performance as an observation beside the candidate evidence.
Admission never reads the observation, a failed measurement only logs why it recorded nothing, and a rerun keeps the first observation.
The workflow keeps both search reports as artifacts for 90 days.
The browser campaign uses the built client and Worker output from the `check` stage.
It covers automatic search, Japanese composition, early input, on-device search and its switch from server results, offline search, old URL redirects, exact-name ranking, call/map/detail/source actions, external-link confirmation, the absence of copy controls, native no-JavaScript continuation, retries, changed snapshots, untrusted result text, local assets, nonce handling, HTTP contracts, and complete-download hashes.
It also queries every prefecture and category against native D1.
Browser failures retain screenshots, videos, traces, and structured diagnostics under `test-results`.
Design cases retain native video even on success.
WebKit uses native video instead of Playwright screenshots because its screenshot synchronizer injects a stylesheet that violates CSP.
The console and CSP gates remain enabled, and no context bypasses CSP.
WebKit reports a fetch that a navigation cancelled as an access-control failure, so the console gate ignores that report only for same-origin URLs, which can't fail access control.
The page also stops an unfinished index load when it's hidden and starts it again when it's shown.
The [native-select compatibility decision](adr/hashed-native-select-style-compatibility.md) records the search-page style-attribute hash and its positive and negative controls.
The [route split decision](adr/serve-directory-json-to-the-site-only.md) records which routes serve only the site.
Unit tests send each `Sec-Fetch-Site` value and an absent header to a site route and to the open-data index.
They require 403 only for a site route with a header other than `same-origin`.
They require cross-origin headers on the open-data routes and none on any site route.
A path table requires each `/api` path to reach exactly one route family.
The data page keeps the strict CSP of every other page, and its CSP tests plant a style attribute, a stylesheet, and a script.
The palette gate covers CSS and SVG opacity as well as masks, gradients, shadows, filters, blending, and paint colors.
Its negative controls run in isolated fixtures.
CSV fixtures independently parse serializer output and cover embedded commas, quotes, newlines, empty values, and all ten guarded formula prefixes in every free-text column.
A fixed-seed property requires that guard to match the serializer's own formula escaping for generated text.
The verbatim telephone cell admits only validated E.164 numbers, and the writer refuses a contact whose number would bypass that schema.
Publication fixtures use native D1 batches to lose a response after commit, resume from its checkpoint, preserve every bound value, and roll back both records and checkpoints after an invalid batch.
A seeding fixture over local SQLite records each statement that preparation sends.
It sees the counts and the foreign key check once for a fresh unbound database, and never for accepted evidence, an accepted publication, or a refusal.
The same proven one-through-one-hundred bound guards SQL parameter counts.
Remote SQL execution, provider transactions, archive storage, and HTTPS delivery remain external semantic boundaries.
Their checked alternatives are native transaction controls, source-bound import receipts, remote reconciliation, and the public browser and complete-download gate.
Revisit these boundaries if the provider protocol, import schema, or verifier support changes.
The HTML report is under `playwright-report/native`.
Do not edit or rebuild the served application while this campaign runs.

Physical-device contact import, assistive-technology review, production provisioning, real traffic capacity, provider freshness, and telephone reachability remain outside these local checks.
No local result establishes production readiness or authorizes deployment.
