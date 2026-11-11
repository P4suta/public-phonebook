# Physical device verification

Use a development-signed QA bundle identifier and its own App Group.
Record the device model, OS build, Xcode version, source hashes, bundle identifier, compiled API origin, and result bundle privately.
Keep a personal device's serial number, address book, and device diagnostics private.
Production builds exclude the app's diagnostic logs and signposts.
The procedures below collect local QA records only when someone explicitly runs them.

Enable Developer Mode and use an authorized Apple development team.
Use `xcrun devicectl list devices` to confirm the actual destination.
Build the app and its extension with the QA bundle identifier, App Group, and selected HTTPS origin.
A successful signature proves installation eligibility, not feature execution.

## Adaptive display checks

Use Device Hub to open, close, rotate, and change the fold angle of the dedicated iPhone Duo simulator while a query, facility, or source is open.
Check that the query and facility remain selected and that search, back navigation, the menu, settings, and map confirmation remain usable.
Keep public telephone calls outside the scenario.
The automated Duo scenarios exercise rotation, search, details, clearing, larger text, and accessibility audits on the selected display.
The rotation scenario checks device orientation and preserved navigation without inferring orientation from a window's aspect ratio on a device with two displays.
Apple's [Duo guidance](https://developer.apple.com/videos/play/tech-talks/111461/) distinguishes interface orientation from available layout space.
XCTest orientation requests didn't resize the outer display in the local iOS 27.1 run, so the automated suite doesn't claim to exercise folding or all display poses.
On 2026-11-10, the owner confirmed preserved query and facility state and successful detail, source, back, menu, settings, and map-confirmation operations across opening, closing, rotation, and partial folding.
The owner then found that facility details lacked a discoverable way to clear the search.
The detail toolbar and search results expose `検索を消す`, which clears the query and selection and returns to the search screen.
The map confirmation checks its complete title, disclosure, and two actions through exact accessibility labels.
The background map action must remain unavailable while the modal is open.
External handoffs use native alerts and verify cancellation through the system's Cancel button.
The large-text scenario checks disclosure growth and native 44-point toolbar actions.
Facility selection moves focus away from the search field and preserves the query through the [TextField focus binding](https://developer.apple.com/documentation/swiftui/textfield).
The focus binding is inside the searchable sidebar.

## Read-only search

Run `mise x -- just ios-ui-test --live --device` with one iPhone unlocked and connected.
If you connect two or more iPhones, select one with `--device UDID`.
The command checks readiness before building, uses local signing with VerificationRelease and the QA identity, and runs one case with the shared ten-minute execution allowance.
Keep the command within the authorized verification window.
The result bundle and source-bound result live under `target/ios/device-ui`.
An empty suite, skipped case, unexpected case, or runtime warning fails verification.
The command preserves installed production data and changes no caller settings.

Run only `PhonebookUITests/DirectoryUITests/testLivePublicDirectorySearchAndSource` on a personal phone.
The case searches the saved national directory and opens a result and its provenance.
Never run the full simulator harness on the personal device.
Never call an unrelated public telephone number as an E2E fixture.

The maintained provider fixture can serve synthetic records through a temporary HTTPS tunnel.
Set PHONEBOOK_FIXTURE_PUBLIC_ORIGIN to that exact HTTPS origin before starting `tools/native-fixture.ts --serve`.
Compile the same origin into the QA app.
The baseline and updated PHONEBOOK_FIXTURE_REVISION values produce different snapshot identities.
Stop the tunnel and fixture after testing.

## Background execution

Let the QA app save the synthetic national dataset before testing.
Confirm that the saved manifest origin matches the compiled HTTPS origin.
Enable automatic updates.
For a due-update fixture, change only that QA App Group's manifest date and automatic-attempt preference.
Preserve a copy and the active generation identity.

Apple's debugger simulation methods can launch or expire a registered task on a development device.
Invoke them only from LLDB.
Keep private selectors outside product code.
Trigger the bundle's actual PhonebookBackgroundRefresh identifier with the app in the background.
The verification bundle uses page.dial.publicphonebook.devicechecks.refresh.
Observe the actual production handler, network requests, activation, completion result, and unchanged prior generation on failure.
To test task expiry, `PHONEBOOK_FIXTURE_INCOMPLETE=datasets` holds an incomplete dataset listing after real I/O begins.
Expire the task after that observation and verify cancellation and preserved data.

Record debugger-forced launch, expiry, and natural OS delivery as distinct checks.
For the latter, detach the debugger, leave a valid due request, and observe a stated window.
No delivery during that window is inconclusive.
The OS decides its scheduling conditions.

## Carrier identification and system compatibility

A real incoming-call test needs a controlled originating line and an approved test number represented in the saved QA data.
The QA build supplies that number through its `QA用の確認` screen, which the app menu opens.
Enter the controlled line's number and a label there, and press `保存する`.
The app keeps both on the QA iPhone, and the Call Directory extension adds them to the caller names.
Turn the extension on in the iPhone settings, call the QA iPhone from the controlled line, and check the label on the incoming call screen.
Search for the label and press the call button to see the iOS call confirmation, then cancel the call there.
Press `消す` after the test, which removes the number and reloads the extension.
Keep the number out of repository files, issues, pull requests, and logs.
Check the enabled Call Directory extension and actual incoming system UI without enumerating personal contacts.
A receiver alone can't originate that controlled call.
A successful extension reload doesn't establish carrier caller identification.

On 2026-11-09, the owner reported that an incoming call might omit its caller label during Focus.
Caller-label omission remains a known observation with an unconfirmed cause.
Apple's [Focus guide](https://support.apple.com/ja-jp/guide/iphone/iph21d43af5b/27/ios/27) describes silencing calls and notifications but doesn't describe omission of Call Directory labels.
The app [provides identification entries through Call Directory](https://developer.apple.com/documentation/callkit/identifying-and-blocking-calls), while iOS controls the incoming call screen.
The project accepts the observed behavior and adds no workaround.

## Signposted intervals

The QA app marks each synchronization phase as a signposted interval and each import phase's duration as a point, in the `directory` category of the `page.dial.publicphonebook` subsystem.
The Call Directory extension marks each load as an interval with a point every 50,000 entries, in the `caller` category.
Choose Product > Profile in Xcode, add the `os_signpost` instrument to a blank template, record a first run, and keep the trace beside the measurements of #231.
Apple's guide to [recording performance data](https://developer.apple.com/documentation/os/recording-performance-data) describes the instrument.

## Measured first run

`just ios-device-record` measures the first run's three paths on one connected iPhone and walks the on-device checks of this page.
Preflight requires a connected, unlocked iPhone with Developer Mode on.
The tool stops before building when a connection or unlock check fails.
With two or more connected iPhones, pass `--device` and one of the UDIDs that the refusal lists.

The tool reads the service's listing and its delta listing, and records them with the delta from the bundled snapshot in `target/ios/device-measurement`.
The `PhonebookDeviceMeasurements` tests replay that record from a loopback server inside the QA app, which builds in the Release-optimized `VerificationRelease` configuration.
`testBundledImport` saves the bundled archive alone.
`testDeltaFromTheBundle` rebuilds the listed archive from the bundle through the delta and imports it once.
`testBundleThenDeltaFromTheStore` saves the bundle and then applies the delta to the saved store.
Until the service lists a delta from the bundled snapshot, the two delta paths stay pending with that reason.

Each test records `XCTCPUMetric`, `XCTClockMetric`, `XCTMemoryMetric`, and `XCTStorageMetric`, and the saved store's size after each iteration.
Each metric must contain ten finite measurements in its declared unit.
XCTest also runs an unreported warm-up.
The record holds eleven successful observations and ten metric values.
The reader uses `xcresulttool get test-results metrics` instead of wrapping XCTest's built-in metric objects.
The QA host stays idle under `--device-measurements`, and the tool reopens the interactive QA app after the experiment.
Separate untimed imports sample working-directory and scratch sizes at progress and trace boundaries.
Each sample records logical sizes and the sum of per-file allocated sizes from Apple's [`totalFileAllocatedSize`](https://developer.apple.com/documentation/foundation/urlresourcevalues/totalfileallocatedsize).
Missing size metadata fails the experiment instead of estimating a value.
The observed peaks don't claim every allocation spike or unique physical blocks shared through filesystem clones.
The record binds the result to source hashes and the measured app executable's SHA-256.
The instructions retired come from `XCTCPUMetric` on the device, and the step meter counts only the tool's own processes on the Mac.
The tool also records the size of the `VerificationRelease` app that it built for the device, and the Release size stays in `docs/ios-store-distribution.md`.

The tool then asks for the outcome and a note of each on-device item on this page, and a run without a terminal keeps each item pending.
After the item that leaves the app during an import, it copies the device's crash logs with `devicectl` and fails when a QA bundle report holds `0xdead10cc`.
It writes `target/ios/device-record.json` and prints a section for this page.
Add that section with the three conclusions of #231: the first-run path that the numbers favor, the wait display's budgets, and the prebuilt SQLite option.

The first national campaign completed all three measurement paths on 2026-11-08.
The manual checks remain separate from the automated measurements and keep their actual recorded outcomes.

## Recorded measurement on 2026-11-09

The destination was iPhone Air with iOS 27.2, build 24B119, and Xcode 27.2, build 27B52.
The app used the Release-optimized `VerificationRelease` configuration.
The bundled and target snapshots were `5bd74f20` and `e73309ca`, each containing 667,696 contacts.
The expanded 672,133-contact Web campaign used a separate snapshot.
All seven device tests passed, including the three import paths and four caller-fixture and storage-size tests.
Each path produced ten metric values and eleven successful observations, including XCTest's warm-up.
The medians below keep XCTest's units, where `kI` means one thousand retired instructions and `kB` is the reported byte unit.
The source-bound record and result bundle remain in `target/ios/device-record.json` and `target/ios/device/measurements.xcresult`.

The bundled import's median wall time was 5.246 s, CPU time 6.302 s, and retired instructions 107,093,875 `kI`.
Median peak physical memory was 44,009.144 `kB`, logical writes 256,682.512 `kB`, and saved-store size 192,759,003 bytes.
Its separate space trial ended with 192,759,004 logical bytes and 198,828,032 allocated bytes in the store.
Observed working-directory peaks were 192,759,516 logical bytes and 198,832,128 allocated bytes across 685 samples.
Scratch space stayed at zero.

The delta rebuild followed by one import took a median 8.787 s of wall time, 9.907 s of CPU time, and 153,818,569 `kI`.
Median peak physical memory was 40,814.288 `kB`, logical writes 417,632.784 `kB`, and saved-store size 192,759,008 bytes.
The separate space trial ended with 192,759,008 logical bytes and 199,147,520 allocated bytes in the store.
Observed working-directory peaks were 312,069,317 logical bytes and 328,949,760 allocated bytes across 855 samples.
Scratch peaks were 160,843,674 logical bytes and 164,319,232 allocated bytes.

Importing the bundle and then updating the saved store took a median 16.074 s, 18.432 s of CPU time, and 286,325,377 `kI`.
Median peak physical memory was 43,239.120 `kB` and logical writes 593,847.328 `kB`.
The saved store held 385,517,801 logical bytes and 397,189,120 allocated bytes.
The path keeps both the current and previous generations.
Observed working-directory peaks were 424,406,484 logical bytes and 447,098,880 allocated bytes across 1,538 samples.
Scratch peaks were 80,421,837 logical bytes and 83,894,272 allocated bytes.
Working-directory and scratch peaks are separate observations and don't establish simultaneous maxima.

Keep the first-run path that rebuilds the updated bundle and imports once.
On the measured iPhone, that path used less time, fewer instructions, fewer writes, and less peak working space than importing twice.
Importing twice used less scratch space and could expose the bundled data earlier, but the experiment didn't measure an interactive handoff.

Keep `WaitDisplay`'s initial 7 ms preparation and 3 ms identification allowances per 1,000 rows.
Preparation reached 7.259 ms and identification 2.190 ms per 1,000 rows, while every observed combined import stayed within 9.400 ms per 1,000 rows.
The combined initial allowance exceeds the measured times.
The implementation refines identification time from measured preparation pace.
The constants are initial estimates rather than upper bounds for every phase or device.

The store size alone doesn't justify replacing the bundled archive with a prebuilt SQLite store.
A prebuilt store could avoid import work.
The experiment didn't measure the prebuilt store's compressed distribution size or copy cost.
The 192.8 MB logical store and 13.4 MB Brotli archive represent different compression states and aren't a download-size comparison.
Keep the current archive and revisit a prebuilt candidate if startup requirements change.

The measured QA app held 21,384,200 bytes.
The separate unsigned Release app held 18,082,532 logical bytes and 18,116,608 allocated bytes across 15 files.
The Release size includes the 13,428,507-byte bundled archive and isn't an App Store download size.
The tool reopened interactive QA after the experiment.
The crash-log scan found no QA report containing `0xdead10cc`, while the twelve manual items remained pending in the automated record.
Earlier manual observations keep their original dates and scope.

## Incremental caller names

The extension sends removals and then additions when iOS asks for an incremental load and its loaded record names a kept caller file.
The normal app and QA app have separate caller identification switches in iPhone settings.
Open settings from Public Phonebook QA and enable that exact extension.
Saving a controlled number must report that the iPhone accepted the reload before checking incoming labels.

After an accepted load, use `全件の再登録を確認する` on the QA screen.
The operation prepares a one-use comparison file with 1,001 different labels while preserving the desired national caller file.
The real incremental CallKit request must select the full replacement plan and complete the national entry count within the extension's memory limit.
Change the controlled number's label to a different value, save it, and verify the changed label on an incoming call.
The next incremental request must remove one entry and add one entry within the same limit.
The [held-fixture decision](adr/exercise-caller-replacement-with-a-bounded-held-fixture.md) defines the scenario's scope.

QA completion messages include `result`, `entries`, `removed`, `peakFootprintKB`, `incremental`, and `plan`.
A no-change completion with zero additions and removals doesn't establish a label-change test.
Also check controlled numbers that sort before and after the national range, full loads after toggling the QA extension, and recovery after an expired request.
A refused QA request records its domain and code.

Collect an attached device archive from Terminal after the operations, using a fresh output path:

```sh
sudo /usr/bin/log collect --device-name 'iPhone Air' --last 15m --size 128m --output target/ios/caller-paths.logarchive
```

The attached-device collector ignores `--predicate`.
Filter the private archive after collection with `/usr/bin/log show --archive PATH --predicate 'subsystem == "page.dial.publicphonebook" AND category == "caller"'`.
The command needs `/usr/bin/log` because zsh also names a builtin `log`.
Keep archives and incoming-call screenshots out of repository files and published attachments.
Distinguish the project's `CallDirectory` extension process from the separate `com.apple.CallKit.CallDirectory` system daemon when inspecting termination messages.

On 2026-11-09, the QA iPhone completed the 1,001-label comparison fixture with `incremental=true`, `plan=full`, `entries=561496`, and `removed=0`.
The completion notice reported `peakFootprintKB=2497`.
Changing the controlled number's label then completed with `incremental=true`, `plan=incremental`, `entries=1`, `removed=1`, and `peakFootprintKB=2449`.
Both requests completed in the same provider process.
The notice uses 1,024-byte units, so the sampled footprints were about 2.56 MB and 2.51 MB.
The provider completed both requests without a kernel memory-limit termination.
Separate kernel messages record a nonfatal 6 MB soft-limit event for the `com.apple.CallKit.CallDirectory` system daemon.
The system daemon's PID differs from the extension's PID.
The owner confirmed the changed label on the real incoming-call screen.
The owner then removed the controlled number and confirmed that iOS accepted the reload.
The zero-change completion before the fixture isn't evidence of the label-change path.

Run iOS 18 on a compatible device or simulator runtime and record its actual OS build.
The connected iPhone Air runs its installed newer OS and can't substitute for an iOS 18 runtime.
Keep runtime-download failures and unavailable local runtimes as environmental observations, not universal claims about iOS testing.

## Recorded run on 2026-10-30

The local candidate passed 66 Swift package tests and 23 isolated simulator UI scenarios.
Address Sanitizer and Thread Sanitizer each ran the complete package test inventory.
The mutation run detected 63 executable mutations and rejected two declaration renames at compilation.
The source-bound Lean gate checked 11 theorems, replayed their compiled modules with a fresh kernel, and rejected the false-deletion control.
The TypeScript gate passed 95 unit tests and 37 built-browser checks.
Its proof gate checked 14 verification units and 23 postconditions.
It also rejected deliberate snapshot identity and ambiguity defects.
The private receipts contain the exact source hashes and check configurations.

The physical destination was iPhone Air with iOS 27.2, build 24B119.
The signed QA bundle used the actual Hono provider with synthetic data over a temporary HTTPS tunnel.
The read-only search and provenance UI case passed on that device.
The controlled update selected prefecture 01 with 103 records across three cursor pages.
A debugger-triggered background callback changed the snapshot from d4397175 to 356c1d80, preserved the previous generation, and reported success.

The expiry test waited for a new incomplete HTTP response before invoking the scheduler's debugger expiry method.
The production background handler reported failure and kept the active manifest byte-for-byte unchanged.
After a fresh process and a repeated expiry trial, the production store read the saved records in pages of 50, 50, and 3.
The app continued running after that trial.

These controlled callbacks used a temporary UIKit background assertion during debugger interaction.
They establish behavior under that test condition.
They don't establish natural scheduler delivery or an independent processing budget.
An earlier trial stopped in CoreFoundation after ending the test assertion from a paused background main thread.
The record preserves that stop and its backtrace.
The repeated trial returned to the foreground before ending the assertion and continued without that stop during the observed run.
The first stop's cause remains unresolved.

Keep the model's automatic-update setting consistent with its persisted preference during debugger setup.
Changing only UserDefaults can leave the visible model's automatic updates off, causing a later foreground refresh to cancel the submitted request.
Wait for foreground refresh to settle before clearing the retry date and submitting a due request.
Keep debugger assertions and private scheduler calls outside product code.

A detached observation ran from 14:02:29 to 14:07:10 UTC, a 281-second window.
The app had a due request and automatic updates enabled, without debugger scheduling or a helper assertion during the window.
At 14:06:52 the service received successful discovery, catalog, and contact requests, and the saved generation changed.
The framework record didn't establish a natural task launch and the requests also matched ordinary foreground initialization.
Natural background delivery remains inconclusive.
The test turned off automatic updates through the app model and stopped the temporary service and tunnel after the observation.

## Search with paired devices

The owner reported no physical Apple Watch for the 2026-11-10 session.
Use the dedicated paired iPhone 17 and Apple Watch Series 11 46mm simulators.
CoreSimulator selects compatible installed runtimes, and the result records identify the actual iOS and watchOS versions.
If a local Watch runtime is missing, install it with `mise x -- just ios-simulator-runtime watchOS`.
Run `mise x -- just ios-watch-check` to prepare synthetic phone data, pair the owned simulators, and run the Watch UI cases through Watch Connectivity.
Check the labeled search control, facility results, telephone numbers, publisher, license, external-link cancellation, and accessibility audits.
The command refuses foreign simulator pairs and removes its pair after the check.
Physical checks of Bluetooth connectivity, battery use, and wrist interaction require a Watch.
