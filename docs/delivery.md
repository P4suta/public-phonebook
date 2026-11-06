# Independent delivery operations

Use `mise x -- just delivery` to plan and request one operation from a committed checkout.
The command supports independent delivery of the Worker, iOS app, Android app, Cloudflare notification policies, and Better Stack monitors.
The website and server configuration ship in the same Worker artifact.
An operation never selects an unrelated publication as a prerequisite.
Required verification follows the selected artifact's inputs and shared contracts.

## Prepare a plan

Install the pinned tools and locked npm dependencies as described in [deployment](deployment.md).
Fetch the current protected `main` and check out the intended committed revision.
A new dispatch requires the source and controller to equal current protected `main`.
If `main` moves before the workflow starts, validation fails before the job fetches provider credentials.
An existing workflow rerun keeps its original commit and request identity.

```console
mise x -- just delivery plan --targets worker --dataset active
mise x -- just delivery verify target/delivery/plan.json
```

Planning writes `target/delivery/plan.json` without changing a deployment, tag, release, or store record.
The plan records the exact source, selected targets, required checks, app versions, and optional immutable dataset digest.
`--dataset active` resolves the active production Worker's dataset through the existing read-only `ci_observe` configuration.
It refuses a missing or ambiguous controlled publication record.
Pass a known 64-character dataset digest instead when preparing a different stored dataset.
The selected digest remains fixed even if production changes later.

Select `ios`, `android`, `cloudflare-alerts`, or `monitors` with the same `--targets` option.
Comma-separated targets permit independent operations from one saved plan.
`--base COMMIT` compares committed inputs and suggests affected targets when `--targets` is absent.
The comparison commit never claims to be a deployment baseline.
An explicit selection without `--base` uses the source as its comparison and still requires the selected target's checks.
An unknown path or absent comparison for automatic selection requires explicit target selection and the broader applicable verification.

Every selected product artifact requires Worker, iOS, Android, and compatibility assurance.
Evidence reuse avoids repeating unchanged native campaigns.
`delivery platform-key` hashes declared inputs, command identities, actual tool versions, and the platform environment.
`delivery platform` accepts a cached pass only when all those values still match.
The Worker's existing dataset-bound candidate evidence remains authoritative for its native iOS dependency checks.
Path suggestions never replace evidence admission.
API and archive formats remain compatible with the installed clients.
Removing a supported format requires a separate transition decision and evidence that its consumers have retired.

## Request and inspect an operation

```console
mise x -- just delivery dispatch worker
mise x -- just delivery status target/delivery/requests/REQUEST.json
```

Use the request-record path printed by `dispatch` in place of `REQUEST.json`.
The controller saves the complete plan and a random request identity before submitting the workflow.
Submitting the same saved request again queries its status and never sends another dispatch.
If a response disappears, preserve the record and reconcile the original run.
`status RECORD --run RUN_ID` can bind a run outside the bounded recent-run search.
The run must match the repository, workflow, event, protected branch, exact controller commit, title, and original plan artifact.
A successful unrelated run or expired plan artifact can't establish completion.
Failure, cancellation, and an unknown result remain unresolved rather than authorizing retransmission.

The `worker` operation retains the existing zero-traffic candidate, production verification, approval, promotion, and immutable GitHub Release lifecycle in [deployment](deployment.md).
For native delivery, use `ios-testflight` or `android-artifacts` after preparing a plan for the corresponding target.
`ios-testflight` prepares an unsigned archive, signs it in a fresh protected job, and uploads the preserved package from another fresh protected job.
It never submits an App Store review or assigns testing groups.
`android-artifacts` prepares and attests unsigned `.apk` packages and `.aab` bundles, a dependency inventory, and a manifest.
Its manifest remains ineligible for release until local signing and the required emulator checks pass.
Google Play submission remains an owner operation.

## App versions and build identities

```console
mise x -- just delivery plan --targets ios
mise x -- just delivery dispatch version-ios
mise x -- just delivery plan --targets android
mise x -- just delivery dispatch version-android
```

Version preparation creates or updates a release-please pull request for one app.
It never creates a tag, GitHub Release, store upload, or rollout.
The root package configuration includes shared generators outside native directories, and the Rust input classifier filters unrelated Web presentation and server-only changes.
`ios/version.txt` and `android/version.txt` are the canonical three-component display versions.
The iOS proposal also updates `ios/AppStore/metadata.json`.
The manifest must agree with the source version before preparation begins.
The most recent committed change to the app's version file is the preparation baseline.
The controller moves merged preparation pull requests from `version:APP:pending` to `version:APP:merged` only after confirming that the baseline includes their merge commits.
The labels describe preparation rather than asserting a publication that never happened.

Store build numbers are separate from display versions.
One authoritative workflow allocates `run_number * 100 + 1`, with checked arithmetic and a positive upper bound of 2,100,000,000.
Retries preserve the build number and original bytes.
The bound follows [Android version-code requirements](https://developer.android.com/studio/publish/versioning).
The [Apple bundle build version](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion) accepts a numeric string.
Workflow-local counters don't prove global store uniqueness.
Keep the workflow identity stable and reconcile existing uploaded builds.
Before migrating a workflow or admitting another uploader, establish an allocation greater than every accepted store build number.
The controller observes an existing matching upload without uploading it again.
A conflicting or still-processing build requires reconciliation.

## Android handoff

```console
mise x -- just delivery fetch-android target/delivery/requests/REQUEST.json
mise x -- just android-release-check
mise x -- just android-sign BUILD_NUMBER
```

Fetch from the exact candidate checkout after its workflow completed.
The command checks the source and controller attestations for all four original artifacts before atomically installing `target/android/candidate/`.
It refuses to overwrite a preserved candidate.
Use the manifest's `versionCode` as `BUILD_NUMBER`.
The release check requires the configured Android 10 and Android 17 emulator observations and current proof and mutation evidence.
Local signing admits the preserved unsigned manifest and bytes before reading the Keychain password.
Gradle runs without signing credentials.
`apksigner` and `jarsigner` perform the separate native signing operations.
The [Android runbook](android.md) covers installation, signature checks, handset verification, and the store submission boundary.

## Configuration preview and apply

```console
mise x -- just delivery plan --targets cloudflare-alerts
mise x -- just delivery dispatch cloudflare-alerts-preview
mise x -- just delivery dispatch cloudflare-alerts-apply
```

Use `monitors-preview` and `monitors-apply` for the `monitors` target.
A preview uses read-only provider tokens and records sanitized plan lines and a digest of actual desired and observed managed values, source, and account or team scope.
An apply operation produces its own preview before waiting for the `operations-apply` environment approval.
Inspect that run's preview artifact before approving it.
The write job reads the provider again and refuses a changed digest before making any modification.
The existing adapters leave unmanaged resources untouched and verify the resulting managed settings through readback.

The effects journal records `unknown` before each external write, `acknowledged` after an accepted response, and `verified` after complete readback.
A later failure preserves the earlier effects.
The controller refuses to replace an existing journal to replay writes.
An apply job refuses workflow attempt two or later.
Download `configuration-effects`, inspect the provider, and resolve each recorded effect before authorizing a fresh operation and preview.
Automatic rollback and automatic retry of an ambiguous external write aren't provided.

## Credentials and protected environments

Keep the existing Worker environments and scoped Doppler configurations.
Add `version-preparation`, `testflight-signing`, `testflight-upload`, `operations-preview`, and `operations-apply` as distinct protected environments restricted to `main`.
Turn off administrator bypass for each environment.
Signing, native upload, and configuration apply require the owner's approval.
Version preparation and read-only preview don't require a reviewer.
Each environment's `DOPPLER_IDENTITY_ID` must identify an OIDC subject restricted to that exact repository and environment.
Create the corresponding `ci_version_preparation`, `ci_testflight_signing`, `ci_testflight_upload`, `ci_operations_preview`, and `ci_operations_apply` configurations with least-privilege access.
The delivery command doesn't provision environments, credentials, or repository protections.

The version-preparation GitHub App needs Contents, Pull requests, and Issues write permission for the selected repository.
Set `RELEASE_PLEASE_APP_ID` as the environment variable and `RELEASE_PLEASE_APP_PRIVATE_KEY` as its Doppler secret.
Before the first proposal, create the repository labels `version:ios:pending`, `version:ios:merged`, `version:android:pending`, and `version:android:merged`.
Add the pinned `actions/create-github-app-token` commit declared in `versions.yml` to the repository's existing Actions policy.
The native configurations split certificate and provisioning material from the App Store Connect upload key as documented in [store distribution](ios-store-distribution.md).
Configuration roles use the same explicit account, notification destination, and `BETTER_STACK_TEAM`, with read-only tokens for preview and write-capable tokens for apply.
Provider token validity and authorization require a separate live check.

After owner configuration, `delivery-credentials.yml` checks one selected role's transport through OIDC and secret presence.
It never checks out code, builds, signs, mints a GitHub App token, or contacts a publication provider.
A transport pass establishes neither provider permissions nor a successful release.
Local verification hasn't exercised the redesigned credential transport or signing and upload jobs with live credentials.
Preserve the existing credentials and production path until an authorized rehearsal establishes the replacement path.

## Evidence and verification limits

`mise x -- just check` covers TypeScript types, semantic lint, behavioral tests, dependencies, secrets, action pins, and workflow policy.
`mise x -- just check-rust` checks the native tools and delivery workspace.
`mise x -- just delivery-prove` runs Kani 0.68.0 and C Bounded Model Checker (CBMC) 6.11.0 on the actual dependency-free Rust core in a bounded pinned container.
Its 18 harnesses cover selection monotonicity, mandatory checks, unknown changes, admission, unsigned archive identity, cache reuse, version input selection, canonical versions, and bounded build arithmetic.
Every expected harness needs successful assertions and reachable covers.
The same command replays the ten committed version-parser inputs and completes 10,000 fixed-seed runs with cargo-fuzz 0.13.2 and libfuzzer-sys 0.4.13.
The ordinary Rust gate replays the same corpus and canonical round-trip properties without starting a fuzz campaign.
The same gate breaks the real evidence guard and requires an assertion counterexample before issuing a source-bound receipt.
Missing harnesses, timeouts, skipped work, unsupported properties, and stale receipts never count as a pass.

Kani establishes the declared deterministic properties under its supported Rust semantics and finite loop bounds.
It doesn't prove GitHub authenticity, complete input declarations, provider behavior, signing services, OS behavior, or store acceptance.
Repository fixtures, the pinned release-please SDK, simulated provider failures, native tools, and workflow schedule exploration cover complementary boundaries.
The native Lean, sanitizer, mutation, emulator, and UI campaigns remain required by their release paths.
Use `just assurance` for the complete local campaign.
It runs native UI, sanitizer, mutation, and proof checks that the fast gate omits.
Physical incoming-call checks remain deferred to an owner handset session.

GitHub artifacts keep candidate and reconciliation records for seven days.
Preserve the original request, unsigned and signed files, signatures, attestations, proof and mutation receipts, and provider receipts in the owner's authorized artifact archive before they expire.
An expired artifact never authorizes rebuilding or uploading a replacement under an already attempted build identity.
See the [delivery decision](adr/select-delivery-operations-independently-from-required-checks.md) for the tradeoffs and trust assumptions.

## Design

The website, two installed native clients, immutable directory datasets, notification policies, and uptime checks have different publication operations.
Web code and server configuration ship in the same Worker and remain one artifact.
Shared generators and API or archive contracts can affect a client even when no file under its app directory changed, and installed clients keep consuming the service after a server deployment.
The [deployment automation guidance](https://dora.dev/capabilities/deployment-automation/) supports repeatable deployment and backward compatibility.
[release-please manifest mode](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md) supports separate version proposals but doesn't determine provider permissions, compatibility, or approval.

A typed Rust command selects independent operations and preserves an immutable plan and request before dispatch.
The existing Worker publication lifecycle and provider adapters stay underneath that command.
A new request requires current protected `main` and binds its workflow, source, plan, dataset, evidence, and original artifacts through later jobs, and reruns keep the original workflow identity.
Unknown impact broadens verification, target selection never removes a mandatory check, and a product target requires all client and server dependencies.
Passing evidence is reused only for identical declared inputs, commands, tools, and execution assumptions.

Each app prepares its display version in a separate PR-only release-please configuration rooted at the repository.
The production Rust input decision filters commits, so shared root generators stay visible while unrelated Web presentation doesn't bump app versions.
Version preparation uses the version file's committed baseline and preparation-specific merged labels, and it creates no tag or publication.
Store build allocation stays separate and preserves `run_number * 100 + 1` across retries, with the original workflow as the single allocator.
Another workflow or uploader requires an explicit allocation transition and store inventory reconciliation.

Unsigned candidates build without signing or upload capabilities.
Separate fresh protected jobs sign the iPhone app and upload it to TestFlight, and a retry preserves the original signed `.ipa` package.
CI produces attested unsigned Android artifacts, and owner-local signing follows the emulator and proof checks.
The signing helpers admit hashes and identities before accessing keys and don't execute candidate build hooks while keys are available.
Account setup, store review, public rollout, physical caller identification, and live credential configuration remain separate operations.

Independently managed configuration previews with read-only tokens, binds desired and observed managed values to the selected scope, and rechecks that digest before applying.
Each effect persists before the provider call and records an unknown, acknowledged, or verified outcome.
An ambiguous write never replays automatically, and completed effects stay for reconciliation.
Incompatible contracts with installed clients require an ordered transition with an explicit retirement condition.

Kani verifies deterministic decisions in the actual Rust implementation.
Native Lean refinements, tests, mutation campaigns, provider fixtures, and workflow exploration cover their respective boundaries.
Evidence reuse reduces repeated native campaigns but makes complete input declarations a trust assumption.
The controller fails when `main` advances before a new dispatch, which trades arbitrary historical releases for a smaller executable trust boundary.
