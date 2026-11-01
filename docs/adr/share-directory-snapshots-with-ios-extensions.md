---
date: 2026-10-30
---

# Share directory snapshots with iOS extensions

## Status

Accepted.
[Import the national dataset for iOS extensions](import-the-national-dataset-for-ios-extensions.md) supersedes its prefecture selection, paged import, and one-contact saves.
[Search the saved directory on the device](search-the-saved-directory-on-the-device.md) supersedes its national search through the API, its opt-in automatic updates, and its Contact Provider extension.

## Context

The native iPhone app needs national search, explicit contact saving, caller identification, and public contacts with distinct ownership.
The public API provides snapshot-pinned cursor pages, while Apple runs call-identification and Contact Provider extensions independently from the host app.
A failed update must not expose incomplete records or discard the last complete local dataset.
The saved region selection needs to evolve without changing search behavior or each extension's data model.

## Decision

Use SwiftUI with an iOS 18 deployment target and native system font.
Keep the app and both extensions under `ios/` in the service repository, with a Foundation-free decision core and thin native adapters.
Use the existing anonymous read API for national search and snapshot-pinned cursor pages for locally selected prefectures.
Keep extensions and automatic updates opt-in.

Store immutable SQLite generations in an App Group shared by the host, Call Directory extension, and Contact Provider extension.
Validate the complete selected dataset and build its extension projection before replacing the active manifest atomically.
Serialize publishers with a cross-process SQLite lease.
Keep the current and previous generations so paginated readers can pin a generation and Contact Provider can read changes and deletions.
Expire anchors that outlive those generations rather than combine snapshots.

Project extension entries by canonical telephone number.
Keep each source record and preserve the names and provenance of records sharing a number.
Use an explicit ambiguity label in both projections when distinct registered names share a number.
Keep one-contact saves behind the system contact editor and supply managed public contacts through Contact Provider.
Request monthly background processing and retry overdue automatic work when the app becomes active without promising an execution date.

## Consequences

Search remains national regardless of the regions saved for extensions.
Interrupted or invalid downloads leave the last complete active generation available.
Prefecture selection is an input to synchronization rather than a dependency of either extension.
Per-number projection avoids duplicate Call Directory identifiers and arbitrary names for shared numbers.
It also aligns the provided contact name with the call-identification ambiguity when the OS prefers a contact match.

Immutable generations and materialized projections require extra disk space during updates.
The store keeps one previous generation, so delayed readers may need to restart.
App Group provisioning and Apple extension execution remain device-specific boundaries.
Background scheduling depends on the operating system.
The public source's current reachability is outside the app's contract.

Downloading the complete national dataset by default would consume unnecessary storage and make extension capacity harder to manage.
Writing all public contacts into the personal address book would mix ownership and complicate removal.
Mutating an active SQLite database would expose readers to partial publication unless every extension adopted a more complex shared transaction protocol.
Separate databases for each extension would duplicate validation and could publish inconsistent generations.

The [native app guide](../ios.md) records build commands, verification scope, and physical-device checks.
