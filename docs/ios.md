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
DevRelease and ProductionDebug make environment independent of optimization.
Swift Build compiles the Swift packages with their Debug configuration when a configuration name contains `debug` or `development` in any case, and with their Release configuration otherwise.
Every debug configuration name therefore contains `Debug`, no release configuration name contains either word, and the generator rejects a name that breaks that rule.
DevRelease and VerificationRelease compile the packages with `-O` and debug information, like Release.
A DevRelease simulator build for one simulator needs no `ONLY_ACTIVE_ARCH` override, because the app and its packages build the same architectures.
Override PHONEBOOK_API_ORIGIN only for an explicitly selected test build.
The generator inspects all six actual Xcode configurations and rejects missing or incorrect environment fields.

The app's property list declares a [launch screen](https://developer.apple.com/documentation/xcode/specifying-your-apps-launch-screen) with the `LaunchBackground` color from `ios/Config/Launch.xcassets`.
That color matches the first screen's white background, as the [launching guidelines](https://developer.apple.com/design/human-interface-guidelines/launching) ask, and the launch screen shows no text or logo.
XcodeGen writes `ios/Config/App-Info.plist` from `ios/project.yml`, and Release and VerificationRelease take that list.
The generator writes `ios/Config/App-Info-LocalNetworking.plist` from it with `NSAllowsLocalNetworking` added, and the generator rejects any other difference.
Debug, DevRelease, VerificationDebug, and ProductionDebug take that second list, because they reach the loopback fixture for development, the UI scenarios, and the store screenshots.
On the iOS 27 simulator, a VerificationDebug build without that key still reached the loopback fixture over HTTP in a UI scenario, and no device has run that check.
The [`NSAllowsLocalNetworking`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking) page recommends the key as a declaration of intent even where the system doesn't block local loads, so those four configurations keep it.
The builds for TestFlight and the App Store carry no transport exception.

Each app build carries one directory archive and a generated entry that describes it, as [the bundled-data decision](adr/start-from-a-bundled-directory-archive-and-catch-up-through-deltas.md) states.
`ios/bundled-dataset.json` names the national dataset by the SHA-256 of its ready manifest.
It repeats the release tag, the snapshot, the row count, the archive length, and the archive SHA-256 for review.
`ios/bundled-fixture.json` names the baseline archive of the provider corpus with the same fields.
`ios-check generate` reads the declared release's `manifest.ready.json`, requires its digest, and takes its `directory.tsv.br` entry.
It never reads the current listing.
It reads the manifest and the archive from `target/datasets/MANIFEST_SHA256/`, which `mise x -- just data-fetch MANIFEST_SHA256 DIRECTORY` can fill.
A missing file comes from the release asset or the entry's immutable URL, so a hosted runner needs no credentials.
The archive must have the declared length and SHA-256.
The `BundledAdmission` tool then admits it with `BundledDataset.admit` from PhonebookKit.
That function checks the format line, the header's snapshot, row count, and `generatedAt`, and every row.
Any difference fails the generator and names the field, and the generator requires one changed archive byte and one changed row count to fail.
The admitted pairs land in `target/ios/bundled-dataset/national` and `target/ios/bundled-dataset/fixture`.
A build phase copies the pair that `PHONEBOOK_BUNDLED_DATASET` names into the app as `directory.tsv.br` and `directory.json`.
Production and verification configurations bundle the national dataset, and Debug and DevRelease bundle the fixture.
The Call Directory extension carries neither file.
The gate compares the VerificationDebug and Release apps and the exported TestFlight app with their declaration, and a changed byte must fail that comparison.
The fast gate refuses a national declaration whose dataset `sources/shipped-snapshots.json` lacks, because preparation writes deltas only from listed datasets.
The fixture never ships, so the list never names it.

The app keeps the whole national directory on the device.
The first launch opens a setup flow that starts the download when the reader presses the start button, explains caller identification, and then waits for the data.
Over that button, a notice names the listed size rounded up to whole megabytes and suggests a fast connection.
Without the listing, the notice names the 14 MB of the archive on 2026-11-04.
The notice turns bold with the info icon on an expensive or constrained path, which `NWPathMonitor` reports.
A relaunch after the start button continues the download without another press.
The app adds nothing to the Contacts app, and deleting the app removes everything it saved.
The app reads `/api/datasets` and picks the one file whose `format` is `public-phonebook-directory/1`, and it skips entries in other formats unread.
When the listing has no file in that format, the app asks the reader to update it.
It downloads that `directory.tsv.br` and accepts it only when its length, the SHA-256 digest of the whole file, and its snapshot header match the listing.
The received bytes stay in the store's `transfers` directory after a failure or suspension, and the next attempt asks for the rest with a Range request.
A 206 reply must start at the kept length and end at the listed length, a 200 reply starts the file again, and a 416 reply discards the kept bytes.
A changed snapshot or digest names a different file, so the app discards the kept bytes of every other file.
The app removes the file once its generation activates, and a file lock keeps two downloads from writing it at once.
`APIClient` owns one ephemeral `URLSession` for its JSON requests and one for its dataset transfers, and the last copy of the client invalidates both.
Each request still carries its own path rules, because `allowsExpensiveNetworkAccess` and `allowsConstrainedNetworkAccess` on a request override the session.
The transfer session sets `waitsForConnectivity`, so a transfer without a connection waits for a path, and the wait display shows the weak-signal line at once.
The JSON session fails at once without a connection, so the listing and its retries keep their timing.
The transfer's 900-second resource timeout bounds the wait, and the first download's retry schedule takes over after it.
A refused connection also waits, because the session connects again only when the network path changes.
Apple lists a forbidden mobile path among the reasons to wait, so an automatic transfer whose path turns costly waits within the same bound.
It decodes the Brotli stream with the system Compression framework and validates the signature, the header dictionaries, every row, the byte order of the rows, and the per-prefecture counts.
It saves the rows in a new SQLite generation with a file of normalized names and a file of row categories, and activates the generation atomically.
The store saves one batch of 1,000 rows while the reader parses the next batch, and it saves the batches in archive order.
A failed or cancelled import keeps the existing generation, and the current and previous generations remain readable.
An import that ends with the app process leaves the active generation in place, and the next save removes the unfinished files.
The first download uses any network path.
After the first run, a launch or a return to the foreground makes the daily check that `PhonebookCore.UpdateCheck` decides.
The check reads `/api/datasets` with `If-None-Match` once 24 hours have passed since the last answered read, and a first run whose listing answered counts as that read.
A 304 reply or a listing of the saved snapshot starts no transfer.
A listing of another snapshot starts its delta or the complete archive at once on a path that is neither expensive nor constrained.
On mobile data, a personal hotspot, or Low Data Mode, that automatic transfer waits, whatever its size, and the next report of an inexpensive path from `NWPathMonitor` starts it.
The transfer reuses the checked listing's body, so it reads the listing no second time, and its requests also refuse those paths through `allowsExpensiveNetworkAccess` and `allowsConstrainedNetworkAccess`.
A transfer that the person starts, such as the first download or the QA screen's, may use any path.
A failed check keeps the saved data and says so in Settings without speaking.
The record of the last answered read, its ETag, the listing body, and a waiting transfer stays in the app's defaults, so a background task in a new process continues it.
A background app refresh task makes the same check and shares the 24-hour limit, and it leaves a transfer waiting for the background processing task.
The background processing task performs a waiting transfer and its import, and without one its earliest date falls a month after the saved snapshot's `generatedAt`.
Updates stay silent.
A clock set back delays the next check until it passes the last answered read by 24 hours.
While the first download runs, the ready step and the search start screen show one heading, one bar, and three steps.
The steps are receiving the data, preparing the search, and preparing caller names.
The bar follows the transfer up to 40 percent and then the saved share of the archive's rows up to 95 percent.
The last 5 percent covers the number table, the caller file, COMMIT, fsync, and activation, and the bar never falls, even across retries.
The percentage stays in the accessibility value and out of sight.
`PhonebookCore.WaitDisplay` decides the line under the current step, and [its decision record](adr/count-the-first-download-down-toward-a-deadline-that-only-moves-earlier.md) states its rules and thresholds.
VoiceOver hears the start, a weak signal, a stop, and the end, and nothing for each step or second.
A stopped first download names its automatic retry, which follows `DownloadSchedule.retryDelays`.
The app transfers in the foreground, so it shows no background transfer line, and a suspended transfer resumes when the reader returns.
The transfer holds a file lock and the import holds an exclusive SQLite transaction, and iOS terminates an app that it suspends while it holds either one.
A first download or update that the open app starts runs under background execution time from `beginBackgroundTask(withName:expirationHandler:)`.
When that time expires, the handler cancels the synchronization and releases both locks before it returns, and the app ends the background task once the synchronization has unwound.
The handler unlocks the transfer lock and rolls back and closes the `writer.sqlite` lease connection, which shares no statement with the import, so it never waits for the store actor.
After that release the cancelled work takes no new lock, and a staging generation opens through SQLite's `unix-none` file system, so its writes hold no file lock either.
`PhonebookCore.BackgroundTime` decides when to cancel and when to end, and the background processing task keeps its own expiry handler.
The directory trace reports the milliseconds of decompression, parsing, row insertion, the number table, the caller file, COMMIT, and fsync for every import.
Parsing and row insertion overlap, so their durations add up to more than the time between the start of staging and the end of decoding.

An update first looks for a snapshot delta when the dataset listing links `datasetDeltas`.
The app reads that listing only when it already saved a directory, and it reads only deltas whose `format` is `public-phonebook-directory-delta/1`.
It downloads only the delta that starts from the saved snapshot.
It checks the delta's listed length and SHA-256, then rebuilds the new archive in a temporary file.
Copied rows come from the saved SQLite rows in archive order, and their dictionary indices pass through the delta's maps.
The app hashes the rebuilt archive while writing it and requires the row count, length, and SHA-256 in the delta header.
The rebuilt archive then passes every check of a complete download before its generation can activate.
After any delta failure, the app keeps the saved generation and downloads the complete `directory.tsv.br`.
A cancelled update keeps the saved generation and downloads nothing more.

`PhonebookCore.FirstRunPlan` maps the bundle state and the listing outcome to the first run's transfer and welcome notice, as the bundled-data decision's table states.
`BundledDataset.open` checks the bundled archive's length, SHA-256, format line, and header with its entry, and a missing or failing bundle counts as no bundle.
`SyncEngine.firstRun` reads the listing, and the delta listing when the listing names another snapshot.
With a listed delta from the bundled snapshot, it decodes the bundled archive into a temporary plain file and records where each row starts.
A `DeltaBase` over that file serves the copied rows, and the delta header's decoded base length and SHA-256 must match the file.
The engine rebuilds the listed archive, stages it with the plain reader, and activates one generation.
With nothing to receive, it stages the bundled archive directly.
With a readable bundle, a failed listing, transfer, rebuild, or check stages the bundled archive alone, and the result reports that fallback.
Bundled rows that fail during staging count as an unreadable bundle.
The decoded base and the rebuilt archive leave with the run after success, failure, or cancellation.
A cut transfer keeps its received bytes in the store's `transfers` directory, as every download does.
Progress reports keep the three stages, so `WaitDisplay` and its proof stay unchanged.

Search runs on the device and sends nothing.
The search field matches facility names and complete Japanese telephone numbers, with the website's normalization and exact, prefix, and substring ranking.
The start screen asks for a facility name or a telephone number in one sentence.
While iOS reports the Call Directory extension as off, a rule, two sentences, and an outline button that opens the app's iPhone settings follow that hint.
The sentences say what the feature shows and ask the reader to grant the app permission in the iPhone settings.
The prompt stays hidden while the state is on, unknown, or still unread, and `PhonebookCore.CallerStatus` holds that decision.
The app reads the state again whenever it returns to the foreground.
The simulator reports no extension state, so debug builds read `PHONEBOOK_CALLER_STATUS` for the UI scenario that draws the on and off states.
Results appear while the reader types, under category headings with three previews each, and each category expands in place.
Each heading shows its category's count, and no line repeats the total.
VoiceOver announces the total once, 0.6 seconds after the results stop changing, like the website's status.
Empty results show `あてはまる施設は0件です` and suggest part of a name or another word.
Result cards show the name as heading text, the prefecture and municipality, and each telephone number, and the detail screen shows the full address and the source information from the saved data.
Each telephone number is large selectable text over a full-width call button, and the app draws no copy control.
Below the telephone actions, one outline button opens the detail screen.
Its label is `住所などを見る` when the facility has an address and `くわしい情報を見る` when it has none.
VoiceOver reads the facility name before that label.
The detail screen shows the address as selectable text, and an outline `地図で見る` button below it opens Apple Maps after a confirmation.
VoiceOver reads that button as the facility name followed by `の地図を見る`, and a facility without an address has no map button.
Settings holds the caller section, which shows a filled check circle with `許可しています` or an empty circle with `まだ許可していません`.
When iOS refuses a reload, `PhonebookCore.CallerReply` decides the state from the [Call Directory error code](https://developer.apple.com/documentation/callkit/cxerrorcodecalldirectorymanagererror-swift.struct/code).
`currentlyLoading` shows `許可しています・iPhoneが読み込んでいます`, `extensionDisabled` shows the off state, and any other error shows `許可しています・次にアプリを開いたときに反映します`.
The app records no generation after a refusal, so the next launch compares the extension's own record with the saved generation and asks again.
The app logs the error domain and code of every refused reload or status read, and nothing else about it.
The About screen shows the date that the app saved its data.

The VerificationDebug and VerificationRelease configurations define the `PHONEBOOK_VERIFICATION_TOOLS` compile condition, and the other four configurations don't.
Under that condition, the app menu adds `QA用の確認`, a screen for one test telephone number and its label.
The [Figma QA section](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=563-2290) holds its design.
The screen reads the number in any spelling that search accepts, and the label starts as `確認用の番号`.
The app saves both in `verification-number.json` in the App Group container, excludes the file from backups, and protects it until the first unlock.
The app writes neither value to a log or a request.
A search that matches the label or the complete number shows the entry under a `QA用` heading with the standard call button.
That button opens the iOS call confirmation, so the owner can check calling with their own number instead of a facility's.
The Call Directory extension reads the file and merges the entry into the national caller numbers in ascending order while it loads them.
After iOS accepts a load, the extension records the generation and the test entry that iOS holds in `callers-loaded`.
When iOS asks for an [incremental](https://developer.apple.com/documentation/callkit/cxcalldirectoryextensioncontext/isincremental) load and the record names a caller file that the store still keeps, the extension streams that file and the active one together.
It removes every number that left or changed its label, and then adds every new or changed entry, each in ascending order.
`PhonebookCore.CallerChange` holds the step decision, and `verification/ios/CallerDelta.lean` proves that the changes turn the held entries into the wanted ones.
Any other record, a record from an earlier app version, or a full request loads every entry as before.
When the national data lists the same number, the test label replaces the national label, because CallKit takes each number once.
`PhonebookCore.CallerMerge` holds that decision, and `verification/ios/CallerMerge.lean` proves the merge.
Saving or clearing the entry reloads the extension, and the screen reports the state that iOS gave with the Call Directory code of a refusal.
A reload that meets `currentlyLoading` waits 3 seconds and asks again, up to four requests, because the running load may hold the earlier entry.
The screen never asks the owner to press the button again.
The screen also shows the saved data date, the last answered check, the next check time, a waiting transfer, and any problem.
Its `いま受け取る` button starts a transfer as the person, which may use any path, or the first download before any data exists.
The gate in `ios-check` scans every file of the unsigned Release app and extension for six markers of the QA code and fails on any of them.
The markers are the screen's type name, the file name, an accessibility identifier, and three phrases of its copy.
The gate also requires all six markers in the VerificationDebug build, so the scan demonstrably sees them.
`mise x -- cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- store-build-control` builds Release with the condition defined.
It passes when the scan rejects that build with all six markers.
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
Run `mise x -- just ios-device-record` with one iPhone connected to measure the first run and walk the manual checks, as [device verification](ios-device-verification.md#measured-first-run) describes.
`just ios-prove` compiles the eight Lean modules and two generated trace modules, and replays two generated roots, `PublicationModels` and `OmegaModels`, with `leanchecker --fresh`.
`--fresh` replays every constant of a root's import closure, and the roots import each module exactly once, so they replay every constant that one run per module would.
`PublicationModel` and `WaitDisplay` both declare `Phonebook.step`, so one root can't import every module.
Each iOS command prints a final JSON line with the step record that [verification](verification.md#required-fast-gate) describes, and `ownInstructions` for the checker's own work.
Steps in a container, Xcode's build service, or CoreSimulator report that work as outside the measured processes.
`just ios-check` reads the build settings of its six configurations at once and checks them in a fixed order.
Every iOS command except `ios-prove` and `ios-unit-test` holds the machine lease, a `flock` on `/tmp/public-phonebook-ios-gate.flock`.
It's the same lock that `lockf -k` takes, so the two exclude each other, and the kernel releases it when its holder exits.
After locking, a command checks that the path still names the locked file, because `lockf` without `-k` deletes the file and a later opener would lock a new one.
When the path names another file, the command locks again on that file.
A second command waits, polling every 30 s for at most 90 minutes, and a wait that runs out fails as inconclusive.
Don't wrap these commands in `lockf` on the same file, because they would then wait for their own wrapper.
Pull requests run none of these native or proof checks.
The manual Assurance workflow runs `just ios-check` on the hosted `xcode-27` runner, and `just prove` and `just ios-prove` on Linux.
Its `campaigns` input adds the sanitizer and mutation campaigns.
No commit, push, or pull request starts the Assurance workflow.
The manual TestFlight workflow runs all four campaigns for one `main` commit before it signs and uploads that commit.

The full UI harness creates and erases its own simulator and reinstalls the app for every scenario.
Each checkout gets its own simulator, named `Public Phonebook Checks` with the first eight hexadecimal digits of the SHA-256 of its path.
The harness starts the fixture on a loopback port that the kernel reports free and passes it as `PHONEBOOK_FIXTURE_PORT` to the fixture and to the UI test runner.
Another process on port 3100 therefore can't stop the gate, and `node tools/native-fixture.ts --serve` alone still uses 3100.
Each scenario runs with a 600-second execution time allowance, a hang guard that exceeds the longest sum of one scenario's own waits.
A scenario that reaches the allowance counts as inconclusive rather than failed, and the gate still stops on it.
Its proxy forwards Range requests and can drip or stall a reply, so the scenarios reach the receiving steps, a weak signal, and a resumed transfer.
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
