# Verification contracts

The website, API, collection tools, and browser tests use TypeScript.
The Apple app uses Swift, and the Android app uses Kotlin.
Rust implements native package and verification helpers.
The repository's commands define the executable check inventory.

## Required fast gate

```sh
mise x -- just check
```

The fast gate runs strict TypeScript checking, Biome, type-aware Oxlint, dependency-cruiser, deterministic tests, npm auditing, secret scanning, and workflow validation.
It needs no production credentials, national archive, native SDK, browser, or container.
The shared directory package rejects imports from app, preparation, and infrastructure code.
The website runtime rejects imports from preparation and infrastructure code.
Rejecting fixtures exercise the installed dependency checker.

Before every push, also run `mise x -- just check-linux`.
Before pushing build or browser-check changes, run `mise x -- just check-build`.
Before pushing Rust changes, run `mise x -- just check-rust`.
Android changes require `mise x -- just android-check` under the app's [implementation rules](../apps/android/AGENTS.md).
Repair failed or incomplete required checks before publishing a change.
Release-stage campaigns keep their release timing.

The final fast-gate output reports step duration and optional instruction measurements.
On macOS, `step-meter` measures its direct child and identifies unmeasured descendant or service work.
Other hosts report unavailable measurements explicitly.
Measurements describe verification cost without controlling the verdict.
The [Apple runbook](ios.md) describes native step reports and failure artifacts.

## Pull-request checks

Pull requests and merge groups run the Checks workflow without production secrets.
Verify runs the fast gate with the required pinned tools.
The build job compiles development and production output, validates production deployment without credentials, and checks bundle budgets.
Scope selects Rust checks and Android checks from their actual repository inputs.
The required Checks summary waits for every job and accepts a skipped Rust job when Scope selected no Rust inputs.

Actionlint checks every workflow.
Zizmor runs offline with its pedantic rules.
The typed workflow policy requires empty workflow permissions, explicit job permissions, allowed actions, and full action commit identifiers.
Untrusted dispatch values enter scripts through environment variables.
OIDC credentials require an environment-bound dispatch or reusable workflow.
Change workflows exclude release-stage browser, proof, and native Apple campaigns.
Gradle's official setup action validates the committed Wrapper and uses GitHub's basic cache.

## Linux verification

```sh
mise x -- just check-linux
```

The maintained runner uses the pinned Playwright container and mise toolchain to run the same fast gate on Linux.
It copies tracked and eligible untracked inputs into an isolated writable checkout.
The original checkout stays read-only.
The container has explicit processor, memory, process, shared-memory, and time limits.
A memory stop or timeout produces an inconclusive result.
The check compares the container's tool installation with the hosted toolchain action.
It also replays the exact native contract corpus across host operating systems.
The `--control` mode plants a host-specific gzip header and requires the Linux corpus assertion to reject it.

## Build and browser contracts

```sh
mise x -- just check-build
```

The command builds the website and Worker, checks the Rust workspaces and generated kanji variants, and prepares an isolated browser fixture.
The browser fixture needs no production credentials or national archive.
Its cases cover search, Japanese composition, startup, details, source links, confirmation, privacy, accessibility, and layout.
The bundle budget limits the compressed Worker to 1 MiB and the search Worker script to 72 KiB.

Miniflare tests execute the real API and database adapter with native D1.
They cover keyset traversal, independent category continuation, bound SQL values, snapshots, cache separation, and malformed responses.
A workerd test checks raw Brotli bytes to detect double encoding.
The maintained preview server uses Miniflare's HTTPS socket because Vite's Node response relay can decode Brotli while preserving the encoded length.
WebKit requires HTTPS for Brotli negotiation.
Loopback browser contexts trust the fixture certificate.
The production Content Security Policy remains enabled during browser checks.

Browser tests require local search to stop sending queries after index activation and to keep searching offline.
They check replacement failures, changed snapshots, transfer restrictions, and absence of browser tracking storage.
Failure artifacts preserve screenshots, videos, traces, and bounded fixture diagnostics under `test-results`.
WebKit captures use native video or Playwright screencast frames when screenshot preparation conflicts with the Content Security Policy.

## Source-bound proofs

```sh
mise x -- just prove
mise x -- just delivery-prove
mise x -- just ios-prove
mise x -- just android-prove
```

The directory gate translates annotated production policies through the pinned LemmaScript generator and checks the generated Dafny.
The expected function inventory, verified conditions, rejecting controls, tool versions, and source inputs live in `tools/prove.ts`.
The gate refuses changed generated output, missing functions, incomplete conditions, timeouts, and controls without the required counterexample.
It checks search bounds, ranking arithmetic, composition decisions, API admission, import identity, archive access, and delta reconstruction under their declared assumptions.
The [ranking contract](search-ranking.md) and [reading contract](search-readings.md) describe the linguistic and runtime boundaries.

The native helper gate checks actual Rust decisions with Kani, replays version-parser cases, and runs its bounded fuzz campaign.
Apple and Android gates refine declared production decisions to Lean models, replay the complete theorem inventory, and require rejecting controls.
The native runbooks describe the corresponding implementation mappings and platform tests.
Proofs establish their stated properties under verifier assumptions.
They don't establish publisher accuracy, complete input declarations, operating-system scheduling, filesystem durability, provider behavior, or store acceptance.
Behavioral tests and actual platform observations cover the applicable external boundaries.

Owner-side proof campaigns use the project's bounded containers.
GitHub runners use the documented native verifier setup.
Empty scans, skipped harnesses, stale results, and unsupported verification never count as passing checks.

## National data and browser campaign

The Web release workflow fetches the committed immutable dataset and verifies every artifact before using it.
Data checks reconcile contact and source counts, dictionaries, phone relations, archive bytes and digests, search rows, delta instructions, and SQLite integrity.
Telephone checks require canonical-number agreement, display round trips, and unique numbers within each contact.
Source anomalies stay available for investigation without speculative digit repairs.

The browser job builds the client and Worker and seeds local D1 from that dataset.
Search parity compares public API results and counts with the prepared search implementation.
The full campaign runs Chromium, Firefox, WebKit, and mobile WebKit.
It covers online and offline search, every prefecture and category, composition, continuation, external actions, HTTP contracts, and complete-download hashes.
Keep the served build unchanged throughout a campaign.
The [deployment runbook](deployment.md) describes the production dataset pin and workflow entrypoints.

## Release workflow policy

The website deployment requires successful repository, dataset, browser, and proof checks before the production build.
The protected deployment job verifies the preserved build's repository, workflow, source revision, and signer before fetching credentials.
The same `publication-production` concurrency group serializes database preparation, deployment, and restoration.
Cloudflare's retained Worker versions supply recovery history.
Historical publication journals remain readable without controlling current deployment.

`tools/workflow-schedule.ts` models job dependencies, conditions, status functions, inherited success checks, and propagated skips.
It checks the finite admitted combinations of inputs, job outcomes, and unknown output predicates.
Its specifications require successful predecessors and explicit write selection.
Rejecting fixtures plant workflow defects and require the corresponding property to fail.
The model's correspondence with GitHub scheduling remains a trust boundary.

The build job preserves Cloudflare Build Output, GitHub provenance, and an npm-generated CycloneDX software bill of materials.
The protected job deploys the verified bytes and checks the public site afterward.
Provenance identifies origin without establishing source correctness.
The dependency inventory describes production packages without establishing the exact bundled module set.

## Release assurance

```sh
mise x -- just assurance
```

The complete local campaign runs build and browser checks, directory and native proofs, native Apple tests, sanitizers, and Apple and Android mutation campaigns.
The hosted Assurance workflow offers the corresponding manual checks.
Each app distribution workflow requires its applicable complete inventory independently of website deployment.
Native result reuse requires identical declared source inputs, commands, toolchains, operating-system builds, simulator runtimes, and output digests.
A changed or missing input requires verification again.
Physical caller identification, assistive-technology operation, store package installation, and store acceptance need their documented platform observations.

The [Apple runbook](ios.md), [device verification guide](ios-device-verification.md), [App Store guide](ios-store-distribution.md), and [Android runbook](android.md) define platform requirements.
Build and QA artifacts describe controlled contributor operations.
The service doesn't collect user search terms, incoming numbers, diagnostic logs, or usage analytics.
