# Native store preparation

The iPhone app's name is Public Phonebook, identifier 6828899028, with Japanese as the primary language.
Its production bundle identifier is page.dial.publicphonebook and its `SKU` is public-phonebook-ios.
The source display version comes from `ios/version.txt`.
Match the selected display version with the intended App Store version before submission.
App Review approval releases the version automatically, and the app requires no sign-in.
Store metadata lives in `ios/AppStore/metadata.json`.
Japanese customer-facing text is intentional.
Review instructions are English.
The [accessibility evaluation](ios-accessibility.md) defines common tasks, feature criteria, automated audits, device evidence, and the boundary for declaring Accessibility Nutrition Labels.

## Environments

Production uses the unsuffixed bundle identifier, the name Public Phonebook, the unbadged icon, and `www.dial.page`.
Development uses the `.development` suffix, the name `Public Phonebook DEV`, the `DEV` icon, and `127.0.0.1:3100`.
Verification uses the `.devicechecks` suffix, the name `Public Phonebook QA`, the `QA` icon, and `www.dial.page`.

Each environment derives its own App Group, extension identifiers, and background task identifier from the app bundle identifier.
The environment and optimization are independent.
App Store and TestFlight use the same production archive.
The `DEV` and `QA` icons identify separate installations.
The [Figma library](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=317-1020) owns all nine app icon masters.

`mise x -- just ios-generate` inspects all six Xcode configurations and both native targets.
It checks that production, development, and verification identities match their resolved Xcode settings.
Its finite negative controls change and remove each environment field and require rejection.
This check covers the declared configuration inventory.
Future configurations and OS behavior need their own checks.

## Private archive

Configure the authorized team in the ignored `ios/Signing.local.xcconfig`.
Run `mise x -- just ios-archive` to create a production Release archive and export a local App Store `.ipa` package.
The command uses Xcode's existing account and automatic provisioning.
It never uploads the package or submits a review.
The command inspects the exported app and its embedded extension and verifies their signatures and distribution entitlements.
It checks the production origin, shared group, version, build number, icon, privacy manifests, and bundled notices.
It also requires the exported app to hold the directory archive and entry that `ios/bundled-dataset.json` declares, and the extension to hold neither.
The generator reads that archive from the release asset and the immutable dataset URL, so the hosted runners get it without credentials.
The unsigned Release app measured 3,780,791 bytes before bundling the national archive.
The first bundled baseline held 17,274,257 bytes with the 13,428,507-byte archive of snapshot `5bd74f20`.
On 2026-11-09, the unsigned Release app held 18,082,532 logical bytes and 18,116,608 allocated bytes, including the same archive.
Local app-bundle sizes aren't App Store download sizes.
It preserves the SHA-256 digest, source-file hashes, selected Git revision, dirty-tree state, and a CycloneDX dependency inventory under a unique `target/ios/app-store-*` directory.
`target/ios/app-store-candidate.json` points to the inspected export from the command's preceding successful run.
A local archive uses build number 1 unless `--build-number N` selects another.
`--require-receipts` refuses to archive unless the native, sanitizer, mutation, and Lean receipts passed for the current sources.
A private local archive is never eligible for release, and only the TestFlight workflow below produces a release-eligible package.

## Store build delivery

The `TestFlight` workflow in `.github/workflows/ios.yml` delivers a signed production build to TestFlight.
Prepare an iOS plan and request `ios-testflight` through the [independent delivery command](delivery.md).
Its controller refuses a source that differs from protected `main`, a changed plan, or another workflow identity.
Dependency checks, formal assurance, and native assurance run independently at the same commit.
A Linux job runs `just ios-prove`, and a macOS job runs `just delivery platform ios --scope check`, `just ios-sanitize`, and `just ios-mutate`.
Candidate and TestFlight share the check-only result when sources, commands, toolchains, and the native output receipt's digest match.
Missing or changed outputs rerun verification.
Jobs for the same source commit serialize their native work.
The unsigned job waits for every required dependency, formal, and native check.
The unsigned job downloads their source-bound receipts and runs `just ios-prepare-archive N` without signing credentials or account provisioning.
It preserves and attests the unsigned archive, source inventory, and receipts.

The signing job waits for review in `testflight-signing` and verifies the unsigned artifact's source and controller attestation before fetching credentials from `ci_testflight_signing`.
Before importing a private key, the controller copies the original archive and gives both bundles an ad hoc signature containing the declared App Group request.
That signature uses no certificate or private key and preserves the request that Xcode needs during export.
The original attested archive stays unchanged.
`just ios-archive --prepared --require-receipts --build-number N --signing ci` refuses a dirty checkout, mismatched archive bytes, or failed and stale receipts.
It checks both profiles for their identifiers, team, App Group, and App Store distribution type.
The helper imports the distribution identity into a temporary keychain and exports the already prepared archive with manual signing.
It executes no project generation or archive build after importing that identity.
It removes the keychain and profiles and verifies the exported signatures, entitlements, metadata, and bundled dataset.
An `always()` step also attempts keychain cleanup.
The job preserves the resulting `.ipa` package, dependency inventory, and candidate manifest as the signed candidate artifact.

The upload job uses the separate `testflight-upload` environment and `ci_testflight_upload` identity.
It verifies the original signed candidate's attestation before fetching the App Store Connect key.
`just ios-testflight` records the upload attempt before invoking `xcrun altool --upload-package` and queries App Store Connect until the build is `VALID` or the bounded wait ends.
The controller reconciles an already attempted build by app, version, build number, artifact digest, and source identity.
The helper never sends another upload after an ambiguous response.

Reruns preserve the original unsigned archive, signed `.ipa` package, and build number `run_number * 100 + 1`.
The project's Info.plist files take `CFBundleVersion` from `CURRENT_PROJECT_VERSION`, which the archive command sets.
Keys, private certificates, provisioning profiles, and secrets never become workflow artifacts.
Original package and upload-attempt artifacts are essential retry evidence and remain available for seven days.
Preserve them in the authorized owner archive before they expire.
A missing original artifact or attempt record stops reconciliation rather than authorizing a replacement upload.
The [delivery decision](adr/select-delivery-operations-independently-from-required-checks.md) records the changed retry contract and the counter's allocation assumptions.

## Submit an app update

Prepare an iOS version proposal with the delivery command, verify its checks, and merge the proposal before preparing the distribution plan.
Use the same App Store Connect app record, a higher display version, and a fresh TestFlight build number, following [Apple's version procedure](https://developer.apple.com/help/app-store-connect/update-your-app/create-a-new-version/).
Read the changes since the published version when writing the required What's New text.
Copy the promotional text from `ios/AppStore/metadata.json` when the draft leaves that field empty.

Run `mise x -- just ios-ui-test --live --device UDID` with the connected iPhone unlocked for the source-level QA check.
The command uses VerificationRelease and the separate QA identity.
It keeps production data and doesn't perform calls, collect device logs, or change caller-identification settings.
Its result doesn't replace testing the distributed package.

After TestFlight processing succeeds, install the preserved build through TestFlight on the iPhone.
Check an update over the installed version, the saved directory, search, details, source, and settings before selecting that same build in App Store Connect.
Keep the existing caller-identification setting and check incoming labels with an owned line when caller behavior changed.
Keep incoming numbers on the phone.
Repeat VoiceOver, Voice Control, and large-text checks when affected screens or accessibility behavior changed.
[Apple's release testing guidance](https://developer.apple.com/documentation/xcode/testing-a-release-build) explains why a development-signed QA build doesn't establish the distributed build's behavior.

Use Safari for the authenticated App Store Connect session.
Save the draft, verify the selected version and build, and submit the update for App Review only after the distributed build check passes.
An upload or review submission doesn't establish App Store availability.

### Doppler values

The signing job reads `APPLE_DISTRIBUTION_CERTIFICATE_BASE64`, `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD`, `APP_PROVISIONING_PROFILE_BASE64`, and `CALL_DIRECTORY_PROVISIONING_PROFILE_BASE64` from `ci_testflight_signing` in the `public-phonebook` Doppler project.
The certificate value contains the Apple Distribution certificate and its private key as a password-protected `.p12` file.
The app profile covers `page.dial.publicphonebook`, and the extension profile covers `page.dial.publicphonebook.CallDirectory`.
Both profiles require the `group.page.dial.publicphonebook` App Group and the selected distribution certificate.

The upload job reads `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, and `APP_STORE_CONNECT_PRIVATE_KEY_BASE64` from `ci_testflight_upload`.
The key ID is the ten-character identifier of the App Manager API key, the issuer is the team issuer identifier, and the private-key value contains the downloaded `AuthKey_KEY_ID.p8` file.
Store each file as standard base64 on one line, for example with `base64 -i FILE`, so that the log masks it whole.
The commands refuse empty values, unresolved Doppler references, and malformed encoded files.

### Owner setup

Reuse the existing API key, certificate, and profiles when valid.
Don't create another identity to recover an interrupted upload.
Configure each protected environment with its own `DOPPLER_IDENTITY_ID`, subject, and read-only access to its matching secret configuration.
The signing subject is `repo:P4suta@42543015/public-phonebook@1438449191:environment:testflight-signing`.
The upload subject ends in `environment:testflight-upload`.
Restrict both environments to `main`, require the owner's review, and turn off administrator bypass.
Run the dedicated read-only credential transport workflow before an independently authorized signing or upload rehearsal.
A private export rehearsal preserved the declared App Group and production identity in both bundles without uploading a package.
The redesigned command doesn't migrate or delete the previous `testflight` environment and `ci_testflight` configuration.

### What stays manual

The owner assigns processed builds to TestFlight testing groups and supplies App Store submission and review details.
Certificate, profile, and API-key renewal and the corresponding scoped Doppler updates remain owner operations.

The package uses local PhonebookCore and PhonebookKit targets with no remote Swift package dependencies.
The archive step derives the inventory's library components from the generated Xcode project and `swift package dump-package`.
It follows the package products that the app and its embedded extension link through their target dependencies.
It lists each linked regular target once and omits system library targets, whose libraries the iOS SDK supplies.
It refuses package dependencies, products from another package, conditional dependencies, and linked executable or test targets.
The unsigned job records the derived targets in its candidate record, so the signing job never evaluates the package manifest.
Lucide and Feather-derived glyphs carry their original notices inside the app.
Foundation, SwiftUI, CallKit, BackgroundTasks, Compression, SQLite, and the Swift runtime come from the Apple platform.
The privacy manifest declares app-owned UserDefaults use with CA92.1.
The app uses HTTPS from the operating system and includes no custom encryption algorithm.
The export-compliance key declares no non-exempt encryption.
Confirm the applicable [Apple export-compliance requirements](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/) before submission.

## Store completion

Use real app screenshots in Japanese, with no personal data or simulated carrier-call claims.
The [current screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications) require an accepted iPhone display size and prohibit transparency.
The app targets iPhone only.
Supply a production API that serves the versioned contract and a live public privacy policy before review.
The support and privacy routes are `/support` and `/privacy`.
Apple needs a live public URL.

Check that the app-privacy declaration matches the exact app and deployed service, including retained network data and third-party delivery practices.
The app doesn't upload personal contacts or call history and includes no advertising or tracking SDK.
Ephemeral request processing and retained collection have different meanings in [Apple's privacy definitions](https://developer.apple.com/app-store/app-privacy-details/).
Don't infer the final store label solely from an empty collected-data array in the binary's privacy manifest.
Keep the review contact's phone number and email out of the repository.
The owner supplies those private fields and any legally binding trader or tax declaration.

Before upload, preserve an owner-approved source revision and fresh candidate checks, and bind the package and screenshots to it.
Complete age-rating, availability, accessibility, privacy, encryption, and review-contact fields from verified behavior.
Don't claim physical carrier identification, iOS 18 execution, or natural background delivery from simulator or debugger evidence.
Submission requires its own owner authorization, and the owner authorized the automatic release after approval.

## Preparation evidence

The store record and native concepts use Public Phonebook.
Japanese remains the primary store language and the declared app localization.
The first complete native run passed 66 package tests and 24 UI scenarios before the localization metadata change.
The Japanese-localization audit then reported clipping in a link containing a license identifier.
An outer size modifier didn't resolve that report.
The source view now gives the license identifier its own row and provides a descriptive VoiceOver label and value.
The UI tests keep the accessibility audit and assert that the license value survives a failed source request.
Read the receipts for the exact source and scenario scope of each run.

The store screenshots come from the real native app and a local copy of the public snapshot ffef99d97b0ca14774178d6a7e3af35c7c1dba116a904a843cdec8b34dd2354a.
The prepared data passed integrity checks for 650933 contacts, 546133 phone numbers, and 724 sources.
Screenshot capture uses ProductionDebug with an explicit loopback service and Japanese locale.
The distributed Release package uses the production HTTPS origin.
Run `mise x -- just ios-screenshots ORIGIN` with a bare HTTPS or loopback HTTP origin that serves the versioned API.
The command runs the live UI case on the erased check simulator and exports its three Japanese attachments as opaque images with red, green, and blue channels.
It rejects a failed case, a missing or repeated attachment, transparency, and any size other than 1206 × 2622.
`target/ios/app-store-screenshots.json` records each image digest with the origin, configuration, simulator, source revision, dirty-tree state, and source digests.
