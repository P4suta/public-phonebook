# Native app

The SwiftUI app and its Call Directory extension live under `ios/`.
The deployment target is iOS 18.0.
The project pins Xcode 27.2 and Swift 6 language mode.
A deployment target and a successful device build don't establish execution on an iOS 18 runtime.

Install the tools in `mise.toml`, run `mise x -- npm ci --ignore-scripts`, and run `mise x -- just ios-generate`.
Open the generated `ios/PublicPhonebook.xcodeproj`.
Create the ignored `ios/Signing.local.xcconfig` with DEVELOPMENT_TEAM set to an authorized development team.
The app and its extension require the configured App Group.
Production and verification use https://www.dial.page.
Development uses the loopback provider fixture at http://127.0.0.1:3100, which `mise x -- node tools/native-fixture.ts --serve` starts.
Each environment has its own bundle identifier, App Group, background task identifier, name, and icon.
Debug maps to development and Release maps to production.
The verification scheme uses VerificationDebug for tests and VerificationRelease for archives.
DevelopmentRelease and ProductionDebug make environment independent of optimization.
Override PHONEBOOK_API_ORIGIN only for an explicitly selected test build.
The generator inspects all six actual Xcode configurations and rejects missing or incorrect environment fields.

The app keeps the whole national directory on the device.
The first launch opens a setup flow that saves the directory and then explains caller identification, which the reader can turn on or postpone.
The app adds nothing to the Contacts app, and deleting the app removes everything it saved.
The app reads `/api/datasets` and picks the one file whose `format` is `public-phonebook-directory/1`, and it skips entries in other formats unread.
When the listing has no file in that format, the app asks the reader to update it.
It downloads that `directory.tsv.br` in one request and accepts it only when its length, SHA-256 digest, and snapshot header match the listing.
It decodes the Brotli stream with the system Compression framework and validates the signature, the header dictionaries, every row, the byte order of the rows, and the per-prefecture counts.
It saves the rows in a new SQLite generation with a file of normalized names and a file of row categories, and activates the generation atomically.
A failed or cancelled import keeps the existing generation, and the current and previous generations remain readable.
The app saves over Wi-Fi and cellular networks, shows only the saved percentage, and updates about once a month.

An update first looks for a snapshot delta when the dataset listing links `datasetDeltas`.
The app reads that listing only when it already saved a directory, and it reads only deltas whose `format` is `public-phonebook-directory-delta/1`.
It downloads only the delta that starts from the saved snapshot.
It checks the delta's listed length and SHA-256, then rebuilds the new archive in a temporary file.
Copied rows come from the saved SQLite rows in archive order, and their dictionary indices pass through the delta's maps.
The app hashes the rebuilt archive while writing it and requires the row count, length, and SHA-256 in the delta header.
The rebuilt archive then passes every check of a complete download before its generation can activate.
After any delta failure, the app keeps the saved generation and downloads the complete `directory.tsv.br`.
A cancelled update keeps the saved generation and downloads nothing more.

Search runs on the device and sends nothing.
The search field matches facility names and complete Japanese telephone numbers, with the website's normalization and exact, prefix, and substring ranking.
Results appear while the reader types, under category headings with three previews each, and each category expands in place.
Result cards show the name as heading text, the prefecture and municipality, and each telephone number, and the detail screen shows the full address and the source information from the saved data.
Below the telephone actions, one outline button opens the detail screen.
Its label is `住所などを見る` when the facility has an address and `くわしい情報を見る` when it has none.
VoiceOver reads the facility name before that label.
The about screens, privacy notes, data sources, and licenses are part of the app, and only facility, map, and source pages open in the browser after a confirmation.

The actual Hono handlers produce the shared provider corpus with the dataset listing and the archive.
The corpus also holds the fixture's updated revision with its delta listing, its delta from the baseline, and its complete archive.
Swift tests import that corpus through the real synchronization path.
They rebuild the updated archive from the saved baseline and compare it byte for byte with the archive the provider wrote.
Run `mise x -- node tools/native-fixture.ts --write-corpus` only when intentionally updating the provider and consumer together.
The TypeScript unit tests regenerate the responses and reject a stale corpus.
Set `PHONEBOOK_FIXTURE_CONTACTS` and `PHONEBOOK_FIXTURE_CATALOG` to a production `contacts.jsonl.gz` and catalog to serve a real-data archive from the fixture.

Run `mise x -- just ios-unit-test` for all compiled Swift package tests, strict lints, and coverage.
Run `mise x -- just ios-check` for those checks, unsigned simulator and device builds, and the complete isolated simulator UI inventory.
Run `mise x -- just ios-prove`, `mise x -- just ios-sanitize`, and `mise x -- just ios-mutate` for the heavier assurance checks.
Pull requests run none of these native or proof checks.
The manual Assurance workflow runs `just ios-check` on the hosted `xcode-27` runner, and `just prove` and `just ios-prove` on Linux.
Its `campaigns` input adds the sanitizer and mutation campaigns.
No commit, push, or pull request starts the Assurance workflow.
The manual TestFlight workflow runs all four campaigns for one `main` commit before it signs and uploads that commit.

The full UI harness creates and erases its own simulator and reinstalls the app for every scenario.
It turns off slide-to-type and its introduction, because that introduction can cover the screen under test.
The UI and screenshot commands shut that simulator down when they return, including after a failed scenario.
An interrupted command leaves it booted, so run `xcrun simctl shutdown all` afterward.

Every UI scenario keeps its result bundle under `target/ios`.
A failed scenario also leaves `target/ios/ui-failures/<scenario>/` with the exported summary, test details, and activities.
Its `failure.json` names each failing assertion with its repository-relative source line and lists the test steps with their start offsets and durations.
The `attachments` folder holds the screenshots, the accessibility tree, and the screen recording.
It also holds the fixture request log, which gives each request's arrival time, upstream status or error, and upstream duration.
Each wait is a named step, and a timed-out wait reports its elapsed time and, while saving, the save progress and save error on the screen.
`simulator.log` holds the app's directory trace with the test runner, SpringBoard, RunningBoard, and testmanagerd messages from the scenario.
`host.log` holds the host's memory, swap, load, simulators, and CoreSimulator log from the scenario.
The gate prints each failing assertion and its location, and records them in the UI receipt.
The gate checks that the simulator is still booted before each scenario.
If it isn't, the gate keeps `host.log` under `target/ios/ui-failures/simulator-before-<scenario>/`, boots the simulator once more, and records the recovery in the UI receipt.
A second departure from the booted state fails the run.
A failed or cancelled Native assurance job uploads `target/ios` as a seven-day artifact.
Never run the destructive simulator setup on a personal phone.
Use only the read-only live case and the [device verification procedure](ios-device-verification.md) on a physical device.
The [assurance map](ios-assurance.md) separates proven core properties from Apple and filesystem boundaries.
The [icon library](icons.md) supplies native assets from the Figma sources.
The [App Store preparation procedure](ios-store-distribution.md) describes Japanese metadata, signed export, evidence, and submission boundaries.
The [release readiness record](ios-release-readiness.md) lists completed checks, open work, and its owners.
