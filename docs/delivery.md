# Delivery workflows

GitHub Actions owns workflow selection, job dependencies, artifacts, environments, and concurrency.
Start an operation from protected `main` with the standard GitHub CLI.
Each operation uses the GitHub workflow run identity.
The [deployment runbook](deployment.md) covers website publication, dataset bindings, and Cloudflare recovery.

## App version proposals

Each app has its own version file and release-please configuration.
Version preparation opens or updates a pull request without tagging or publishing an app.
The shared version adapter selects app and shared-contract commits and preserves a canonical three-component version.

```sh
gh workflow run versions.yml --ref main -f operation=version-ios
gh workflow run versions.yml --ref main -f operation=version-android
```

Review and merge a version proposal before preparing the corresponding store candidate.
The version file supplies the display version.
The workflow run number supplies the separate store build number.

## Apple app distribution

Review the intended source and run the applicable checks locally before starting distribution.
For app or interface changes, run the native verification with the fast checks.

```sh
mise x -- just check check-rust ios-check
```

For production core or proof changes, also run the affected sanitizer, mutation, and proof commands.
Reuse successful results while their checked inputs remain unchanged.
After verification and merge, dispatch the protected main-branch workflow.

```sh
gh workflow run ios.yml --ref main
```

The TestFlight workflow runs fast repository checks and prepares an unsigned archive.
The archive job has no signing or upload credentials.
Fresh protected jobs verify the original artifact, sign the preserved archive, and upload the preserved package.
GitHub attestations bind the files to the repository, workflow, and exact source revision.
Signing and upload use separate environment-bound Doppler configurations.
Approve the signing environment after reviewing the source and applicable local results.
Approve upload after verifying the preserved package.
The [local verification decision](adr/keep-ios-assurance-local-and-distribution-protected.md) records the trust boundary.

Build allocation preserves `run_number * 100 + 1` across retries.
Keep the workflow identity stable and reconcile accepted store builds before introducing another allocator.
A retry reuses the original artifact and observes an existing matching upload.
A conflicting or uncertain upload requires reconciliation before another write.

The [App Store runbook](ios-store-distribution.md) covers local preparation, physical-device checks, metadata, and review submission.
Passing a simulator check doesn't establish physical caller identification or App Review acceptance.

## Android handoff

```sh
gh workflow run android.yml --ref main
gh run list --workflow android.yml
mise x -- just delivery fetch-android RUN_ID
mise x -- just android-release-check
mise x -- just android-sign BUILD_NUMBER
```

The Android workflow checks the app and preserves unsigned Android Package (APK), Android App Bundle, software bill of materials, and manifest files.
Run artifact retrieval from the matching source checkout after the selected workflow succeeds.
The helper checks the workflow identity and every artifact's provenance before installing the candidate directory.
It refuses to overwrite preserved candidate bytes.
Use the manifest's `versionCode` as `BUILD_NUMBER`.

The release check requires the configured Android emulator observations and current proof and mutation results.
Gradle Wrapper builds without signing credentials.
Native signing tools read credentials after candidate validation.
The [Android runbook](android.md) covers installation, signatures, handset verification, and store submission.

## Configuration preview and apply

```sh
gh workflow run operations.yml --ref main -f operation=cloudflare-alerts-preview
gh workflow run operations.yml --ref main -f operation=cloudflare-alerts-apply
```

Use `monitors-preview` and `monitors-apply` to manage uptime checks.
The preview reads provider configuration with read-only credentials.
An apply operation preserves its own preview before waiting for the `operations-apply` environment approval.
Inspect the preview artifact before approving the write job.
The adapter reads the provider again, refuses changed managed settings, and leaves unmanaged resources untouched.

The effects journal records an uncertain outcome before each external write and verifies acknowledged effects through readback.
An interrupted or ambiguous write doesn't replay automatically.
Inspect the provider and the `configuration-effects` artifact before starting a fresh operation.
An apply job refuses workflow attempt two or later.

## Verification and privacy

`just check` runs deterministic repository checks.
`just check-rust` verifies the native build helpers.
`just assurance` runs the broader browser, native, proof, sanitizer, and mutation inventory.
Each distribution workflow requires its applicable complete checks.
Native result reuse requires identical declared inputs, tools, commands, and execution assumptions.

Build outputs and bounded QA artifacts describe contributor operations and fixture runs.
The service doesn't collect user search terms, incoming numbers, diagnostic logs, or usage analytics.
Preserve private distribution artifacts in the owner's authorized archive before GitHub retention expires.
An expired artifact doesn't permit rebuilding under an already attempted store identity.

The [workflow decision](adr/deploy-tested-worker-builds-through-github-actions.md) records the replacement of project-specific publication coordination.
