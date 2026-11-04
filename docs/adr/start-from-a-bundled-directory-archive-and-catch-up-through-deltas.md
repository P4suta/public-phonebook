---
date: 2026-11-04
---

# Start from a bundled directory archive and catch up through deltas

## Status

Proposed in #224.
It amends [Count the first download down toward a deadline that only moves earlier](count-the-first-download-down-toward-a-deadline-that-only-moves-earlier.md), whose policy now measures a shorter run.
It partly supersedes the first-run download and the monthly cadence of [Import the national dataset for iOS extensions](import-the-national-dataset-for-ios-extensions.md).
It partly supersedes the retention rule of [Publish target-ordered deltas between directory archives](publish-target-ordered-deltas-between-directory-archives.md).

## Context

The iPhone app can't search until it saves a directory.
Today the first run downloads the complete `directory.tsv.br` after the person presses `はじめる`, then imports every row.
The production snapshot holds 667,696 contacts in a 13,428,507-byte archive, which decodes to 80,421,837 bytes.
The welcome notice names the listed size and turns bold with the info icon on an expensive or constrained path.
The ready step then shows one bar, three steps, and the countdown of the first-download record.
A stopped first download retries on a schedule, and the person can't reach search until it succeeds.

The app already applies a delta from its saved snapshot when the listing offers one, and it downloads the complete archive after any delta failure.
Preparation writes deltas only from bases named on its command line, and the `Collect` workflow names none, so the production manifest lists no deltas.
Monthly updates use only paths that are neither expensive nor constrained, and `RefreshPolicy` counts the month from the time the app saved its data.
The dataset listing answers with `no-cache, must-revalidate` and no ETag, so a client can't make a conditional request for it.
The deployment target is iOS 18.0.

One preparation measured a delta, from the 650,933-contact base to the production snapshot.
The delta took 374,905 bytes, 2.8 percent of the archive, and kept every base row as a copy while adding 16,763.
Its maps renumbered 719 of 720 provenances, 879 of 883 links, and 20 categories.
A row-by-row difference of the same pair matched no row and took 26,499,639 bytes.
No device has measured the import, and the 7 ms and 3 ms budgets per 1,000 rows come from unoptimized simulator runs.

The owner wants a first run that starts at once and keeps the current first-run screen and flow.
No one may wait on the network to start, and no data update may need a submission to Apple.

## Decision

### Bundle

Each app build carries one directory archive and its ready-manifest entry.
`ios/bundled-dataset.json` names the dataset by the SHA-256 of its ready manifest and repeats the snapshot, the archive length, and the archive SHA-256 for review.
The build reads that manifest from the dataset's release record and requires its digest to match.
It takes the archive from the manifest entry's immutable URL or from `just data-fetch`.
It admits the archive with the app's own download checks: length, SHA-256, format line, header snapshot, and row count.
Any mismatch fails the build, and the build never picks a dataset on its own.
Production and verification configurations bundle the national dataset, and development configurations bundle the fixture archive under their own declaration.
UI scenarios run the VerificationDebug build and point it at the fixture server through a launch variable.
Debug builds also accept a launch variable that names the fixture archive in place of the bundled one.

`sources/shipped-snapshots.json` lists each dataset that a TestFlight or App Store build bundles.
The fast gate refuses an iOS declaration whose dataset that list lacks.
The list sits outside `ios/`, because the data stages read it and their declared inputs exclude `ios/`.

### First run

The welcome screen, `はじめる`, the caller step, the ready step, the bar, the steps, the countdown, and the slow and weak-signal lines keep their design.
At launch the app checks the bundled archive as it checks a download, and treats a missing or failing archive as no bundle.
A pure plan in `PhonebookCore` chooses the transfer and the welcome notice from the bundle and the listing.

| Bundle | Listing | Transfer | Welcome notice |
| --- | --- | --- | --- |
| Readable | Names the bundled snapshot | None | The no-transfer notice |
| Readable | Lists a delta from the bundled snapshot | That delta, on any path | The delta's size |
| Readable | Lists no delta from the bundled snapshot | The complete archive, on any path | The archive's size |
| Readable | Unreachable | None for now | The no-transfer notice |
| Missing or unreadable | Any | The complete archive, on any path | The archive's size, as today |

The person starts the transfer with `はじめる`, so it may use expensive and constrained paths as well.
The no-transfer notice reads `データはアプリに入っています。` and `通信せずに準備できます。`.
The size notices keep today's wording and emphasis rule, which matters most for the complete archive.
A size under 1 MB shows one decimal rounded up to 0.1 MB, such as `受け取るデータは約0.4MBです。`.
A size of 1 MB or more keeps today's rounding up to whole megabytes.
The notice may change once when the listing answers.
On the Figma page `468:1270`, frame `567:2364` shows a delta's notice, `567:2406` the no-transfer notice, and `470:1302` and `554:2195` the complete archive's.
The no-transfer notice is the `Connection=Not needed` variant `567:2360` of the data size notice.

With a delta, the app decodes the bundled archive into a temporary plain file with a table of row offsets.
It rebuilds the target archive from that file through the delta and imports the rebuilt archive once.
`SyncEngine` supports this with one addition, because `DeltaBase` already reads copied rows through a closure.
A base over the decoded bundle replaces the saved store as their source.
That base also lets the app check the delta header's decoded base length and digest, which the store's base can't.
When nothing needs receiving, the heading reads `アプリで使うデータを準備しています` instead of `アプリで使うデータを受け取っています`.
The receive step then shows as done, and the import runs the other two, as frame `568:2443` shows.
The wait policy and its proof stay unchanged.

With a readable bundle, a failed listing, transfer, rebuild, or check ends the run with the bundled archive alone.
The ready step then names the date of the data and says that new data arrives automatically, as frame `567:2451` shows.
The stopped state and its retries remain only for a missing or unreadable bundle.
The caller step stays optional, as the first item of App Review Guideline 5.1.2 requires.

### Update check

After the first run, a launch or a return to the foreground reads the dataset listing when 24 hours have passed since the last read.
It sends `If-None-Match` with the saved ETag, and the listing gains a strong ETag of its body and answers 304 on a match.
Only an answered read starts the 24 hours, so a first run that finished offline checks again at the next launch.
Automatic transfers, which follow the daily check or the background task, never use a constrained path such as Low Data Mode.
On an expensive path, such as cellular, they transfer only a delta from the saved snapshot of at most 2,000,000 bytes.
A larger delta or the complete archive waits for a path that's neither expensive nor constrained.
The background processing task takes the same decision and shares the 24-hour limit.
Its earliest date counts a month from the saved snapshot's `generatedAt` instead of the time of saving, so a bundled snapshot older than a month is due at once.
A Lean model bound to the digest of the Swift decision proves the limit, the threshold, and the path rule over every finite input.

### Delta retention

Preparation writes a delta from every dataset in `sources/shipped-snapshots.json` and from the last 12 published datasets.
The cap of 12 applies only to the published datasets.
Every delta keeps the rule that its Brotli bytes stay at or below half of the complete archive.
A shipped dataset whose delta breaks that rule gets none, the store job reports it, and its app version downloads the complete archive on an inexpensive path.
That report means the next app release needs a newer declaration.
The `Collect` workflow's store job fetches each base's manifest and archive from `dial-control` by dataset digest before preparation.
It learns the published datasets from the release records in `dial-control`.
A base that it can't fetch or verify fails the job before any write.
An entry leaves the list in a reviewed change, at least 12 months after the App Store stopped offering a version that bundles it.
An early removal costs that version a complete download and never breaks it.

### Alternatives

Apple-hosted Background Assets with an essential pack would deliver the archive with the app install.
App Store distribution of each asset pack version goes through App Review, as [WWDC25 session 325](https://developer.apple.com/videos/play/wwdc2025/325/) shows.
This personal project won't submit anything to Apple to update data, so that review alone rules the option out.
The [asset pack overview](https://developer.apple.com/help/app-store-connect/manage-asset-packs/overview-of-apple-hosted-asset-packs/) also limits the service to apps that target iOS 26 or later, while this app targets iOS 18.0.
It serves only TestFlight and App Store builds, so the simulator gate would need Apple's mock server instead of the delivery path.
A [developer forum thread](https://developer.apple.com/forums/thread/805124) from October 2025 lists undocumented behavior and defects.
A reply there reports packs that still don't work after following Apple's guide, and Apple hasn't answered.
A bundled archive also changes only with an app release, but it's only the starting point, and every later update arrives through the project's deltas.

A prebuilt SQLite store in the bundle would skip the import.
It would carry the store's files instead of a 13.4 MB Brotli archive, and copying it into the App Group container still writes the whole store.
No device has measured the size of the store or the cost of the import.
The device measurement in retired instructions decides whether the import, not the transfer, dominates the first run, and this option waits for it.

Content-defined chunk downloads would let a client fetch the chunks of the decoded archive that it lacks, with no delta for each base.
In the measured pair, the renumbered dictionaries changed the bytes of every row, which is why the row-by-row difference matched no row.
Chunks over the decoded archive see those same bytes, so they would match almost nothing and transfer about the whole archive.
Chunks over the Brotli stream fare worse, because a change early in the stream alters the bytes after it.
Chunking would need stable dictionary indices, a new archive format, and every scattered added row would still cost a whole chunk.
This conclusion rests on one measured pair, because production preparation has written no delta since.

A light mode with names and telephones beside a full mode would shrink what the app carries.
Brotli at quality 11 with a 24-bit window, over the production rows without the header lines, measured these sizes.

| Fields | Bytes |
| --- | --- |
| Every field | 13,373,343 |
| Every field except the address | 8,433,397 |
| Category, region, name, and telephones | 6,586,214 |
| Name and telephones | 6,249,306 |
| The address alone | 4,254,833 |

With a bundled archive, the first run already transfers a delta or nothing, so a light mode would save about 6.8 MB of app size and no transfer.
It would double the onboarding copy, the deltas, and the UI scenarios, and it would add a notice for the limited mode.
A bundled core with details fetched later carries the same costs.
If the app's size becomes a concern, split the archive into a core layer of categories, regions, names, and telephones and a details layer.
The app would then fetch the details layer in the background as a whole, never for one contact, so no request reveals which facility the person looked at.

## Consequences

A first run from a current bundle transfers nothing.
A first run one snapshot behind transfers a delta like the measured one, 2.8 percent of the archive.
A missing network no longer blocks the first run while the bundle is readable.
Such a run searches older data until the update check succeeds, and the ready step says so.
The app grows by about the archive's 13.4 MB, and Brotli bytes gain little from the App Store's own compression.
A delta on the first run needs temporary space for the decoded base and the rebuilt archive, about 80 MB each, beyond the new generation.
If the device measurement finds that too heavy, the app imports the bundle and then applies the delta from the saved store, which imports twice.
An automatic update may use mobile data without asking for a delta of up to 2,000,000 bytes per published snapshot, and it never uses Low Data Mode.
The daily check costs one conditional request, and a 304 reply carries no body.
A new starting snapshot needs an app release, and data freshness doesn't.
Each shipped dataset adds one base archive to fetch and decode during preparation.
The app size, the device import time and instructions, the temporary space, and the store size remain unmeasured.
Issues #225 through #231 track the implementation and the measurement.
