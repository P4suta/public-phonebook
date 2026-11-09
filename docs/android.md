# Android app

Public Phonebook searches a saved national directory and optionally identifies incoming calls on Android 10 or later.
The production package is `page.dial.publicphonebook`.
The verification and development builds use `.verification` and `.development` suffixes and separate private data.
Production and verification contain the pinned national archive.
Development contains the shared 241-contact fixture and disables automatic synchronization.
Production requests use `https://www.dial.page`.
Search terms and incoming numbers stay on the device.

## Build and install

Install the versions in `mise.toml` and set `ANDROID_HOME` to the Android SDK directory.
The build uses Java Development Kit (JDK) 21.
Gradle `9.8.2` runs Android Gradle plugin `9.3.3`.
Kotlin and Compose Compiler both use version `2.4.10`.
Production and test coroutines both use version `1.11.0`.

The compile SDK is 37, and the target SDK is 36.
The Android Gradle plugin uses its [built-in Kotlin integration](https://developer.android.com/build/migrate-to-built-in-kotlin).
The [plugin compatibility matrix](https://developer.android.com/build/releases/agp-9-3-0-release-notes) governs Gradle and SDK compatibility.
Install `platforms;android-37.0` revision 2 and `build-tools;36.0.0` with the Android SDK tools.
The SDK platform package name includes `.0`.
Workflows install both packages through `.github/actions/android-sdk`, which calls `sdkmanager` under `ANDROID_HOME` because hosted runners keep it off `PATH`.
Dependency locks and `android/gradle/verification-metadata.xml` bind dependency versions and SHA-256 checksums.

```console
mise install
mise x -- just android-check
mise x -- just android-install --serial DEVICE_SERIAL
```

The bundle command downloads the pinned archive only when the local cache is absent.
Its declared byte length and SHA-256 must match before Gradle packages it.
An installed app prepares that bundled archive without making a network request.
First preparation needs space for the compressed archive, decoded archive, SQLite database, and search indexes.
Keep the app open while preparation runs.
Preparation failure offers a retry and keeps an incomplete generation inactive.

Use Android Debug Bridge (ADB) and `adb devices` to select a device explicitly.
Enable USB debugging and accept the computer's authorization prompt under the [physical-device setup guidance](https://developer.android.com/studio/run/device).
The installation command opens the verification build without selecting a caller identification role.
Choose the role in the app's caller settings if the device supports it.
Declining or revoking the role preserves facility search.

Text entry follows the recommended [state-based Compose text fields](https://developer.android.com/develop/ui/compose/text/migrate-state-based).
The search keyboard action clears focus and dismisses the keyboard while preserving the query.
Screenshot capture waits for the platform's [accessibility event stream to become idle](https://developer.android.com/reference/android/app/UiAutomation#waitForIdle(long,long)) after Compose becomes idle.

## Data and update design

Android's [architecture recommendations](https://developer.android.com/topic/architecture/recommendations) place repositories between the UI and data sources, and the [offline-first guidance](https://developer.android.com/topic/architecture/data-layer/offline-first) keeps saved data available during network failure.
The Kotlin `core` module keeps validated values and deterministic policies.
The `data` module keeps bounded HTTP, Brotli decoding, strict UTF-8 and JSON validation, SQLite construction, and atomic publication.
The `app` module keeps Compose, ViewModels, WorkManager, roles, and call screening.
The app owns one repository and serializes imports while readers use an immutable complete generation.

An update writes a new directory, validates every row and dictionary reference, and verifies row counts and order.
It builds phone and full-text search indexes and checks SQLite integrity.
Only then does `AtomicFile` replace one pointer containing the current and preceding generation names.
Every candidate gets a unique directory name, including a repeat of an earlier dataset identity.
Activation is marked uncertain before the rename and pointer write.
After a write error, the repository reads the pointer under the same exclusive lock and uses its observed value to determine whether activation committed.
Uncertainty permits either the old or the new complete generation and never implies that a write failed to commit.
Uncertain candidates and both referenced generations stay on disk, and failed cleanup retries during the next preparation.
Android's [AtomicFile contract](https://developer.android.com/reference/android/util/AtomicFile) supplies integrity but no mutual exclusion, so the repository owns the read/write lock.

Strict [JsonReader](https://developer.android.com/reference/android/util/JsonReader) validation runs before any JSON object is built from external bytes.
It requires one complete object, rejects duplicate keys, malformed UTF-8, trailing values, and nonstandard syntax, and bounds nesting before descending.

Search uses FTS4 unigrams and bigrams to narrow candidates, then requires every normalized word with exact substring predicates.
Bound SQL parameters carry search terms, ranking, category selection, and pagination.
The canonical kanji variants and shared search fixtures load from their existing source paths.
The [verified place readings](search-readings.md) add prefecture and common-category prefixes through the same bundled JSON as Web and iPhone.
Reading predicates query saved category identifiers and archive prefecture codes without rebuilding the saved full-text index.
The full-text index is an optimization whose candidates must include every exact match.
Phone lookup uses a separate indexed canonical number and bypasses the word-count limit.

Every matching category shows its complete count and up to three results.
Expanding a category shows its first 30 results, and later requests append another 30 within that category.
Other category previews keep their positions and visible contacts.
Changing the query cancels earlier work, and a generation change restarts the complete preview before appending.
Failed continuation keeps the category's visible contacts and offers a retry.
The native controls keep [stable lazy-list keys](https://developer.android.com/develop/ui/compose/lists#item-keys) and [semantic headings](https://developer.android.com/develop/ui/compose/accessibility/semantics#headings).

The [separate sort key](adr/keep-android-search-order-separate-from-comparison-folding.md) keeps kana folding out of the result order.
Existing saved databases migrate the key locally in a transaction before search, while archive data and caller lookup remain available.
Preview queries stream identifiers and counts before decoding only the selected contacts.
Cancelling a search coroutine also cancels its SQLite queries.
The text field observes its native composing range together with the text.
Conversion drafts cancel earlier work and wait for composition to finish before searching, including an unchanged-text commit.
Preparation and refresh apply their result to the current screen state after the repository operation finishes.
Input committed or composed during either operation stays in the search field.
Preparation and refresh preserve an active composition.
The device UI test drives the real input connection through composition and commit before checking results.

A transfer starts only on an unmetered connection without Data Saver restrictions.
Partial files persist under their expected digest, and a resume requires the exact `Content-Range`.
A complete response restarts the file, a failed delta falls back to the complete archive, and a completed file with a failed digest is discarded.
The next listing check is eligible 24 hours after the preceding response, and [WorkManager](https://developer.android.com/develop/background-work/background-tasks/persistent) supplies persistent scheduling rather than an exact time.

Call screening always returns a response whose blocking, rejection, silencing, and log-skipping fields are false.
An independent one-second response is scheduled before local lookup starts.
A timely name display completes before the response when lookup succeeds, and every other result responds from `finally` with an atomic guard against duplicates.
The [CallScreeningService contract](https://developer.android.com/reference/android/telecom/CallScreeningService) sets a five-second deadline, and the one-second budget leaves scheduling margin.
Actual delivery time and lock-screen behavior remain device observations.

Lean 4 models Boolean admission, arithmetic and nesting bounds, ranking, publication traces, and caller-response invariants.
The maintained Rust gate binds reviewed Kotlin expressions and constants to the Lean model and hashes the checked sources.
Host differential tests, injected failures, and device tests cover the boundaries outside that model, and the [implementation refinement](../verification/android/refinement.md) names them.
The model leaves Unicode runtime behavior, Android scheduling, power-loss durability, and physical call delivery outside its checked semantics.

## Verification

The fast gate checks ktfmt, Detekt, Kotlin warnings as errors, Android lint, and compilation.
Behavioral checks cover shared normalization and rank fixtures, SQLite publication and recovery, strict JSON admission, delta equivalence, and HTTP resume behavior.
Gradle uses a fresh process so semantic analysis doesn't reuse stale dependency classes after a module API changes.
The runner rejects compiler errors from Detekt even when Detekt returns a successful process status.
The Rust tool has its own formatting, Clippy, unit tests, and RustSec checks through `just check-rust`.
The pull-request workflow selects native checks when Android inputs change.
Formal verification and device campaigns remain distribution checks.

```console
mise x -- just android-prove
mise x -- just android-device-check --serial emulator-5554 --fresh
mise x -- just android-release-check --serial emulator-5554 --serial emulator-5556
```

`--fresh` clears only the verification app's private data before testing preparation.
The test artifacts use the Android package format.
The device command records both package digests, Android API level, device model, preparation and search timings, and process proportional set size.
Instrumentation output and screenshots share the record directory under `target/android/devices/`.
Timings describe one run under its recorded conditions.
The device tests search the real bundled data, find a saved telephone number, open a facility, cancel dial and map confirmations, and navigate caller settings.
Emulator results leave a physical handset's telephony behavior unverified.

The 31 theorems in `verification/android/DirectoryPolicy.lean` cover validation, JSON nesting, network constraints, update eligibility, transfer and copy bounds, ranking, and pagination.
The inventory also covers generation publication, uncertain writes, caller policies, and mutation evidence admission.
The source refinement check requires thirteen complete reviewed Kotlin function declarations and the modeled constants.
Two reviewed Rust declarations bind mutation verdicts and campaign completeness to the Lean model.
Publication checks bind the adapter to its actual stage and observed pointer, including a confirmed commit during an uncertain write.
The [implementation mapping](../verification/android/refinement.md) records integer domains, branch correspondence, and the adapter checks.
All arithmetic theorems state their signed 64-bit or bounded word-count assumptions.
The runner hashes its sources, checks the expected theorem inventory, replays the compiled proof in an independent kernel, and requires a planted invalid admission rule to fail the intended theorem.
`target/android/proof/receipt.json` identifies the exact proof inputs and immutable verifier image.

The pinned verifier is Lean 4.34.1.
The proof container has no network access and uses 2 CPUs, 2 GiB memory, no extra swap, and at most 256 processes.
Each proof process has a 900-second safety limit.
A safety-limit stop is inconclusive.
The proof leaves the Android scheduler, filesystem hardware, runtime Unicode tables, and physical call delivery outside its checked model.
The [generation decision](adr/activate-complete-android-directory-generations.md) records those trust boundaries and the adapter checks.

### Mutation and adversarial testing

The test layers follow Android's [testing strategy guidance](https://developer.android.com/training/testing/fundamentals/strategies).
Host checks exercise deterministic decisions and repository contracts before device tests exercise the platform runtime.
Local Android tests pin [Robolectric 4.17](https://github.com/robolectric/robolectric/releases/tag/robolectric-4.17).
Generated cases use fixed seeds and fixed iteration counts.
Tests compare transfer and copy decisions with `BigInteger` arithmetic, including signed 64-bit endpoints.
All admitted word-count distributions, publication phases, validation flags, clock endpoints, JSON depth boundaries, and pagination snapshot combinations have explicit cases.
Seeded cases check phone formatting round trips, Unicode normalization idempotence, and code-point index terms.
Those finite campaigns complement the universal statements in the formal model.

```console
mise x -- just android-mutate --plan
mise x -- just android-mutate
mise x -- just android-mutate --select previous-generation-deleted
```

The [`org.pitest` libraries](https://pitest.org/quickstart/) `1.30.1` and the [Gradle plugin](https://plugins.gradle.org/plugin/info.solidsoft.pitest/1.19.0) `1.19.0` mutate six pure policy classes with the `DEFAULTS` operator set.
Every generated mutation must trigger a failing test.
The report must identify a killing test for every result and include a nonempty result for every declared class.
The Kotlin compiler also emits null checks, collection overflow guards, inline copies, and accessors that need special interpretation under [Kotlin bytecode mutation analysis](https://docs.arcmutate.com/docs/kotlin.html).
The policy scope avoids claiming a useful measurement for generated object accessors and unreachable compiler overflow paths.
Search normalization, telephone parsing, synchronization, storage, HTTP, JSON, delta, query construction, ViewModel behavior, and caller service adapters use the separate source mutation inventory.
Generated accessors and unreachable compiler overflow paths remain outside the bytecode measurement.

The source campaign copies the actual Gradle project into an owned scratch checkout and recompiles each declared production change.
The [Robolectric support requirements](https://docs.arcmutate.com/docs/android.html) describe the special handling needed for bytecode mutations to remain visible inside Robolectric.
Source recompilation exercises the real local Android test task without depending on that commercial integration.
The campaign first runs an unmutated baseline, then requires each mutated run to execute the same named test cases.
Missing reports, skipped cases, dependency failures, initialization errors, memory errors, and hang stops remain inconclusive.
A compile rejection also leaves the behavioral obligation unmet.
Partial selections provide diagnostics and never issue a full-campaign receipt.

`verification/android/mutations.json` declares each changed contract, production expression, and observing test suite.
The fast gate rejects missing expressions, ambiguous replacements, duplicate identities, and empty module coverage.
The release gate requires every declared result and rejects stale evidence.
The Rust verdict conditions have source-bound Lean proofs.
XML parsing, compiler behavior, JUnit execution, and the adequacy of the chosen fault inventory remain explicit trust boundaries.
The fault inventory defines the measured mutation scope and doesn't cover every possible implementation defect.

The bytecode campaign uses one worker and 512 MiB process heaps.
Host test processes use one fork, a 512 MiB heap, and two active processors.
Gradle uses at most two workers.
Each host test task has a safety limit of two minutes.
A safety stop supplies no passing mutation evidence.
Reports under `target/android/mutation/` keep source identities, seeds, baseline output, per-mutation output, and JUnit XML.
The manually requested assurance workflow runs the same campaign on Linux when the caller selects `campaigns`.

SQLite checks compare query results with a full scan.
Queries include ranking, categories, pagination, bound parameters, and full-text search.
Archive and delta checks include malformed dictionaries, row fields, counts, UTF-8, newline boundaries, decoded identities, and invalid copy instructions.
Pointer checks preserve current and previous generations, reject path traversal, and restore an interrupted atomic write.
Transport checks cover interrupted and short reads, exact Range resume, ignored ranges, redirects, encoding, cached identities, and a network restriction that changes during a read.
Synchronization checks exercise a failed delta followed by a full download, persisted pending updates, metered and restricted networks, conditional requests, and the 24-hour boundary.
Development builds also verify synchronization turned off.

Caller service tests use a recording Robolectric shadow and independently controlled coroutine and main-looper schedulers.
The tests check the one-second permission timer before coroutine dispatch, missing and invalid numbers, unavailable storage, destruction before dispatch, and outgoing calls.
Response checks cover every permission flag, duplicate-response prevention, and role-dependent display.
ViewModel tests check cancellation of replaced queries, retained search results after failure, preparation retry, and overlapping refreshes.
Pagination tests prevent appending results from a previous query while the requested query's first page is pending.
Robolectric doesn't establish Telecom delivery, physical call continuity, lock-screen behavior, filesystem power-loss durability, TalkBack behavior, or the Android scheduler's timing.
The physical-device checks remain deferred.

## Caller identification

The app requests `ROLE_CALL_SCREENING` through Android's role-selection screen.
It declares no contacts, call-log, direct-call, overlay, or call-blocking permission.
Under the [CallScreeningService contract](https://developer.android.com/reference/android/telecom/CallScreeningService), an app without contacts access receives eligible numbers outside the user's contacts.
Android excludes restricted and unavailable numbers from that contract.
The service uses only saved data and never blocks a call.
A one-second lookup budget and an independent response deadline leave margin inside Android's five-second deadline.
Role loss, no match, missing data, cancellation, and lookup failure preserve the call.
A timely match opens a private activity containing the facility name and address.

The verification build can save one QA number in private storage and display a test label for that number.
The production build disables that path.
Use a phone number controlled by the tester for a physical incoming-call check.
Verify an unlocked app, a locked screen, a process removed from memory, role refusal, role revocation, no match, and data preparation failure.
Confirm that the normal phone interface continues ringing and that accepting a call still works.
Record the handset, Android release, app digest, role state, lock state, network state, elapsed display time, and actual observation.
Don't record the incoming number or copy a call log into test evidence.
Physical caller identification remains unverified until a later handset test session.
Manual TalkBack reading and handset-specific lock-screen behavior also need physical-device observations.

## Signing and local distribution

Initialize an upload identity once, or configure an existing identity before building.
The initializer writes an encrypted PKCS12 store and non-secret `signing.json` under the owner's `~/.config/public-phonebook/android/` directory.
The password lives in macOS Keychain under `page.dial.publicphonebook.upload-key`.
Gradle prepares unsigned artifacts without signing credentials.
The distribution command reads the password only after the candidate and required checks pass, then supplies it to the native signing tools.
The repository contains neither the store nor its password.
Back up the encrypted store through the owner's private backup process and keep the Keychain item.

```console
mise x -- just android-signing-init
mise x -- just android-distribution BUILD_NUMBER
```

The distribution command verifies the production release checks and builds an installable package and Android App Bundle (AAB).
Replace `BUILD_NUMBER` with the allocated positive version code.
For a preserved CI candidate, use the [Android handoff](delivery.md#android-handoff) and `just android-sign BUILD_NUMBER` to sign the original unsigned bytes.
The canonical display version comes from `android/version.txt` through the checked Rust command, and the build refuses invalid display versions or version codes.
The command requires a current `android-release-check` receipt for both emulator API levels and the exact verification packages.
It verifies both signatures, exports the public signing certificate, and records final byte lengths and SHA-256 digests under `target/android/distribution/`.
Keep the manifest, signature reports, certificate, proof receipt, device receipts, and dependency inventory with the exact candidate.
Archive `target/android/mutation/receipt.json` as `mutation-receipt.json` beside the candidate, and preserve its referenced evidence directory as `mutation-evidence/`.
The evidence contains the baseline reports, fault inventory, per-mutation JUnit output, and bytecode mutation report.
A manifest marked `workingTreeDirty` identifies a local rehearsal.
Before submission, build a replacement candidate from the committed source.
Google Play App Signing distinguishes the upload key from the key used to sign installed Play releases under the [app-signing guidance](https://developer.android.com/studio/publish/app-signing).
Never replace an existing upload identity merely to rerun a build.

Install the signed package with `adb -s DEVICE_SERIAL install -r target/android/distribution/public-phonebook-VERSION-BUILD_NUMBER.apk`, using the filename recorded in its distribution manifest.
The production package can coexist with verification.
Check offline preparation, search, details, and the version on the exact signed package.
Keep a local rollback package and its certificate identity when testing upgrades.

## Store submission

The English app title is Public Phonebook.
The short description is “Find facilities in Japan offline and identify incoming facility calls.”
The full description is: “Search facilities across Japan without sending your search terms to a server.
The app includes the national directory and prepares it without a connection.
Find facility names, regions, categories, telephone numbers, addresses, and source information.
Confirm before opening a number in your phone app, an address in a map app, or an external website.
Optional caller identification matches eligible incoming numbers with the saved directory.
Public Phonebook never blocks a call or reads your contacts or call history.
Directory updates download automatically on an unmetered connection without Data Saver restrictions.
Facility information may change.
Check the source and retrieval date in each facility's details.”

Use the verified candidate's screenshots and the icon and feature graphic in `android/store/`.
The [candidate record](../android/store/candidate.json) identifies the signed packages and the production screenshots.
The support email already published by the service is `support@dial.page`.
The service privacy-policy URL is `https://www.dial.page/privacy`.
Publish the Android privacy disclosure on the website before store submission.
Account creation, identity verification, payment, and publication are separate owner actions.

The native app never transmits search history, incoming numbers, contacts, call logs, advertising IDs, account data, diagnostics, or app interaction analytics.
The Data safety draft answers “No” for those categories.
The native dependencies provide UI, local decoding, concurrency, and scheduled work.
The app integrates no advertising or analytics SDK.
Directory GET requests still expose ordinary connection metadata, including an IP address, to the delivery service.
The owner must confirm Cloudflare logging, retention, processing, and any derived location or identifier use before finalizing the relevant Data safety answers.
An absence of analytics code doesn't establish an absence of service-side collection.
The app uses HTTPS and has no account feature.
External destinations receive a public facility number or address only after confirmation and operate under their own policies.
Review the actual candidate and the delivery-service settings using the [Google Play Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en).

Create the Play app only in the owner's developer account, choose its distribution countries and audience, and complete the content rating and app-access forms.
Upload the signed AAB to internal testing first, compare the upload certificate fingerprint with the local manifest, and exercise the Play-delivered build on a physical device.
Complete the privacy and Data safety review, attach the tested screenshots, and meet the account's testing requirements.
Submit a production rollout only after separate owner authorization.
