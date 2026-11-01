---
date: 2026-11-01
---

# Search the saved directory on the device

## Status

Accepted.
It supersedes the national search through the read API, the opt-in automatic updates, and the Contact Provider extension in [Share directory snapshots with iOS extensions](share-directory-snapshots-with-ios-extensions.md).

## Context

The app already stores every public contact for caller identification.
Searching through the read API sent each search term to the service and needed a connection, although the same records were on the device.
Device testing found that the region and category filters started searches without a name, and that the search field took more space than its purpose needed.
Opening about pages, privacy notes, and licenses in the browser took the reader out of the app for text that never changes between snapshots.
Device testing also showed that the Contact Provider extension put about 650,000 public contacts into the Contacts app.
Those contacts appeared beside the reader's own contacts in daily use.
Apple documents that deleting the app removes provided contacts, but a [developer forum report](https://developer.apple.com/forums/thread/804999) describes contacts that remained after deletion on iOS 26.

## Decision

Search only the active saved generation and send no search term.
Keep one normalized name per line in a generation file and scan it with a byte search, ranked by exact, prefix, and substring matches, then by name length and row order.
Match complete Japanese telephone numbers through the indexed numbers table.
Normalize search terms with the website's rules so that both clients find the same names.
Remove the region and category filters, and show the prefecture and municipality on result cards and the full address on the detail screen.
Show results while the reader types, and replace the visible results only after the next previews load.
Run a first-run setup that saves the directory and then explains caller identification, which the reader can turn on or postpone.
Keep the about pages, privacy notes, data sources, and licenses inside the app.
Remove the Contact Provider extension, and add nothing to the Contacts app.

## Consequences

Search works without a connection and reveals no search term to the service.
Search needs a saved generation, so the first launch leads the reader through the setup before the search screen.
A substring scan of about 650,000 names took 4 to 20 milliseconds on a Mac, and the iPhone timing still needs a device run.
The generation needs extra files for names and categories beside the SQLite database.
The app and the website show the same contacts for the same normalized name, but each client ranks them independently until the website gains its own local search.
The reader's Contacts app stays unchanged, and all saved data lives in the app's own containers.
Public facilities appear only in this app's search and on the incoming-call screen, not in the Contacts app or its search.
