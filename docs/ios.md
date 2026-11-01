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
The app downloads `directory.tsv.br` from the `/api/v1/datasets` listing in one request and accepts it only when its length, SHA-256 digest, and snapshot header match the listing.
It decodes the Brotli stream with the system Compression framework and validates the signature, the header dictionaries, every row, the byte order of the rows, and the per-prefecture counts.
It saves the rows in a new SQLite generation with a file of normalized names and a file of row categories, and activates the generation atomically.
A failed or cancelled import keeps the existing generation, and the current and previous generations remain readable.
The app saves over Wi-Fi and cellular networks, shows only the saved percentage, and updates about once a month.
Snapshot deltas in #55 are the planned way to reduce the monthly transfer.

Search runs on the device and sends nothing.
The search field matches facility names and complete Japanese telephone numbers, with the website's normalization and exact, prefix, and substring ranking.
Results appear while the reader types, under category headings with three previews each, and each category expands in place.
Result cards show the name, the prefecture and municipality, and each telephone number, and the detail screen shows the full address and the source information from the saved data.
The about screens, privacy notes, data sources, and licenses are part of the app, and only facility, map, and source pages open in the browser after a confirmation.

The actual Hono handlers produce the shared provider corpus with the discovery document, the dataset listing, and the archive.
Swift tests import that corpus through the real synchronization path.
Run `mise x -- node tools/native-fixture.ts --write-corpus` only when intentionally updating the provider and consumer together.
The TypeScript unit tests regenerate the responses and reject a stale corpus.
Set `PHONEBOOK_FIXTURE_CONTACTS` and `PHONEBOOK_FIXTURE_CATALOG` to a production `contacts.jsonl.gz` and catalog to serve a real-data archive from the fixture.

Run `mise x -- just ios-unit-test` for all compiled Swift package tests, strict lints, and coverage.
Run `mise x -- just ios-check` for those checks, unsigned simulator and device builds, and the complete isolated simulator UI inventory.
Run `mise x -- just ios-prove`, `mise x -- just ios-sanitize`, and `mise x -- just ios-mutate` for the heavier assurance checks.
The manual Checks workflow accepts an assurance input for the same native and formal candidate checks.
No commit, push, or ordinary pull request starts the macOS assurance campaign.

The full UI harness creates and erases its own simulator and reinstalls the app for every scenario.
It turns off slide-to-type and its introduction, because that introduction can cover the screen under test.
The UI and screenshot commands shut that simulator down when they return, including after a failed scenario.
An interrupted command leaves it booted, so run `xcrun simctl shutdown all` afterward.
Never run the destructive simulator setup on a personal phone.
Use only the read-only live case and the [device verification procedure](ios-device-verification.md) on a physical device.
The [assurance map](ios-assurance.md) separates proven core properties from Apple and filesystem boundaries.
The [icon library](icons.md) supplies native assets from the Figma sources.
The [App Store preparation procedure](ios-store-distribution.md) describes Japanese metadata, signed export, evidence, and submission boundaries.
The [release readiness record](ios-release-readiness.md) lists completed checks, open work, and its owners.
