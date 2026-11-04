# Native store preparation

The iPhone app's name is Public Phonebook, identifier 6828899028, with Japanese as the primary language.
Its production bundle identifier is page.dial.publicphonebook and its `SKU` is public-phonebook-ios.
The version record is 1.0 in Prepare for Submission.
The draft uses manual release and requires no sign-in.
Store metadata lives in `ios/AppStore/metadata.json`.
Japanese customer-facing text is intentional.
Review instructions are English.

## Environments

| Environment | Bundle suffix | Name | Icon | Default API |
| --- | --- | --- | --- | --- |
| Production | None | Public Phonebook | Unbadged | www.dial.page |
| Development | .development | `Public Phonebook DEV` | `DEV` | 127.0.0.1:3100 |
| Verification | .devicechecks | `Public Phonebook QA` | `QA` | www.dial.page |

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
The command inspects the exported app and its embedded extension, verifies their signatures and distribution entitlements, and checks the production origin, shared group, version, build number, icon, privacy manifests, and bundled notices.
It also requires the exported app to hold the directory archive and entry that `ios/bundled-dataset.json` declares, and the extension to hold neither.
The generator reads that archive from the release asset and the immutable dataset URL, so the hosted runners obtain it without credentials.
The unsigned Release app measured 3,780,791 bytes before the bundled archive and 17,274,257 bytes with the 13,428,507-byte archive of snapshot `5bd74f20`.
It preserves a SHA-256 digest, source-file hashes, selected Git revision, dirty-tree state, and a CycloneDX dependency inventory under a unique `target/ios/app-store-*` directory.
`target/ios/app-store-candidate.json` points to the inspected export from the command's preceding successful run.
A local archive uses build number 1 unless `--build-number N` selects another.
`--require-receipts` refuses to archive unless the native, sanitizer, mutation, and Lean receipts passed for the current sources.
A private local archive is never eligible for release, and only the TestFlight workflow below produces a release-eligible package.

## TestFlight delivery

The `TestFlight` workflow in `.github/workflows/ios.yml` delivers a signed production build to TestFlight.
The owner starts it by hand on `main`, and its jobs fail on any other branch.

1. A Linux job runs `just ios-prove`, and a macOS job runs `just ios-check`, `just ios-sanitize`, and `just ios-mutate` at the same commit.
   Each job uploads only its source-bound receipts.
2. The delivery job waits for the owner's review in the `testflight` environment.
   It downloads the receipts and fetches the signing values from the Doppler `ci_testflight` config through GitHub OIDC.
3. `just ios-archive --require-receipts --build-number N --signing ci` refuses a dirty checkout and any receipt that failed or verified other sources.
   It checks both profiles for their identifiers, team, App Group, and App Store distribution type.
   It creates a temporary keychain, imports the distribution certificate for `codesign` only, and installs the profiles.
4. The command archives and exports with manual signing, removes the keychain and profiles, and verifies the export as the local command does.
5. `just ios-testflight` uploads the verified package with `xcrun altool --upload-package` and waits until App Store Connect marks the build `VALID`.
6. An `always()` step deletes the temporary keychain if the command didn't.

Rerunning all jobs or only the failed delivery job gives the delivery a new, larger build number.
The project's Info.plist files take `CFBundleVersion` from `CURRENT_PROJECT_VERSION`, which the archive command sets.
No package, key, certificate, profile, or secret becomes an artifact.
A failed delivery keeps only its command logs, and the commands that write logs never receive the signing values.
The [build-number decision](adr/number-testflight-builds-from-the-workflow-run.md) explains the build numbers, the upload route, and the processing wait.

### Doppler values

The delivery job reads these keys from the `ci_testflight` config of the `public-phonebook` Doppler project.
Store each file as standard base64 on one line, for example with `base64 -i FILE`, so that the log masks it whole.

| Key | Value |
| --- | --- |
| `APP_STORE_CONNECT_KEY_ID` | The ten-character ID of the App Manager API key |
| `APP_STORE_CONNECT_ISSUER_ID` | The issuer ID shown above the team keys |
| `APP_STORE_CONNECT_PRIVATE_KEY_BASE64` | The downloaded `AuthKey_KEY_ID.p8` file |
| `APPLE_DISTRIBUTION_CERTIFICATE_BASE64` | The Apple Distribution certificate and its private key, exported as a `.p12` file |
| `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD` | The password of that `.p12` file |
| `APP_PROVISIONING_PROFILE_BASE64` | The App Store profile for `page.dial.publicphonebook` |
| `CALL_DIRECTORY_PROVISIONING_PROFILE_BASE64` | The App Store profile for `page.dial.publicphonebook.CallDirectory` |

The commands refuse an empty value, an unresolved Doppler reference, and a value that isn't base64 where the table names a file.

### Owner setup

1. In App Store Connect, create a team API key with the App Manager role and download its `.p8` file.
2. Create an Apple Distribution certificate and export it with its private key as a password-protected `.p12` file.
3. Create an App Store provisioning profile with that certificate for each of the two App IDs.
   Both App IDs need the `group.page.dial.publicphonebook` App Group.
4. Fill the seven keys above in the Doppler `ci_testflight` config.
5. Create a Doppler service account with read access to that config only.
   Give it a GitHub OIDC identity for the subject `repo:P4suta@42543015/public-phonebook@1438449191:environment:testflight`.
6. Store the identity's ID as the `DOPPLER_IDENTITY_ID` variable of the GitHub `testflight` environment.
7. Start the `TestFlight` workflow on `main`, then review and approve its delivery job.

### What stays manual

- Adding the processed build to TestFlight testing groups.
- App Store submission, review details, and release.
- Renewing the certificate, profiles, and API key before they expire, and updating the Doppler values.

The package uses local PhonebookCore and PhonebookKit targets with no remote Swift package dependencies.
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
Submission and public release require their own owner authorization.

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
The command runs the live UI case on the erased check simulator and exports its three Japanese attachments as opaque RGB images.
It rejects a failed case, a missing or repeated attachment, transparency, and any size other than 1206 x 2622.
`target/ios/app-store-screenshots.json` records each image digest with the origin, configuration, simulator, source revision, dirty-tree state, and source digests.
