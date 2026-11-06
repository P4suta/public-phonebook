# Android implementation rules

Use the Android platform guidance skill and read the official source for each platform decision.
Compare an affected user outcome with Apple and Web guidance while preserving Android's own API contracts.
The [Android Kotlin style guide](https://developer.android.com/kotlin/style-guide) governs Kotlin naming and layout.
Run `mise x -- just android-check` before committing Android changes.
The gate requires formatting, semantic analysis, compiler warnings as errors, Android lint, shared search contracts, and storage and transport failure tests.
Keep fixed seeds and explicit case bounds for generated behavioral checks.
Run `mise x -- just android-mutate --plan` before a mutation campaign.
The distribution gate requires a failing test for every bytecode policy mutation and every source mutation in `verification/android/mutations.json`.
Never count a compile rejection, empty suite, skipped case, infrastructure failure, or safety stop as a killed mutant.
Keep the unmutated baseline, test identities, source hashes, operator set, and per-mutation output.
Keep source mutations in an isolated checkout and bind completed receipts to the exact source inventory.
Add regression tests for real survivors and rerun the affected family before the complete distribution campaign.
Keep dependency locks and checksum verification current when changing a dependency.
Use named limits and validated domain types instead of unchecked wire values.
Keep decisions in `core`, effects in `data`, and Android lifecycle and interface adapters in `app`.
ViewModels receive repositories and contain no Android context.

Map deterministic obligations to `verification/android/DirectoryPolicy.lean` and the Kotlin refinement gate.
Update the implementation mapping whenever a checked branch, constant, or input domain changes.
The release gate must run the complete theorem inventory, independent kernel replay, and a rejecting negative control.
A proof receipt must match its exact sources.
Keep device scheduling, filesystem durability, Unicode runtime behavior, and caller display as explicitly tested platform boundaries.
Record a missing physical-device result as unverified.

Never send search terms or incoming numbers over the network or into logs.
Network access belongs to the fixed-origin dataset adapter.
Permit every incoming call, including lookup failure, cancellation, missing data, and role revocation.
Caller lookup has a one-second budget and an independent permission-response deadline.
Keep QA numbers and package identifiers separate from production.
External dial, map, and web actions require an explicit confirmation.
Preserve native semantics, 48 dp controls, scalable text, system navigation, and black-and-white light and dark modes.
Keep signing credentials outside the repository and passwords in the owner's Keychain.
