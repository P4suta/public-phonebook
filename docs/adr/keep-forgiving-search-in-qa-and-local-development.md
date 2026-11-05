---
date: 2026-11-06
---

# Keep forgiving search in verification builds and local development

## Status

Accepted.
The implementation brief selects QA and local development as the only permitted uses of forgiving search.
The decision partly supersedes [companion publication](publish-snapshot-bound-forgiving-search-artifacts.md), [device ranking](rank-device-search-with-place-preferences-and-gated-readings.md), [single-list search](show-one-ranked-list-with-a-server-fallback.md), [iOS search generations](activate-ios-search-artifacts-with-directory-generations.md), [mapped search files](map-verified-search-files-from-saved-generations.md), and [packed search](read-packed-search-structures-without-startup-reconstruction.md).
The single result list and literal matching contracts remain in force.

## Context

The packed national ranking companion occupies 47.2 MB compressed, or 54.5 MB together with the name index.
The [packed browser campaign](https://github.com/P4suta/public-phonebook/pull/318) measured about 0.58 GB of added Chromium process memory and 1.2 to 1.8 GB in WebKit, exceeding the 400 MB target.
The [mapped iPhone campaign](https://github.com/P4suta/public-phonebook/pull/321) reached search readiness 4.7 to 5.1 seconds after launch, exceeding the one-second target.
A saved search generation occupies 376.8 MB, and the ranking companion adds about 47 MB to the bundle.
The retained measurements describe the phase 3 national fixture and Simulator or desktop browser environments.
They establish no physical-iPhone performance result.

The measured resource cost outweighs the search improvements for distribution.
The frozen scorer remains useful for the owner's QA and local experiments.
Shipping a runtime setting that starts off would keep distribution bytes and permit accidental activation.

## Decision

Only iPhone configurations defining `PHONEBOOK_VERIFICATION_TOOLS` copy the name index, selected packed companion, and search declaration into the app.
The app constructs the companion repository, migrates saved search files, and opts into the scorer only inside that compilation condition.
Debug, DevRelease, ProductionDebug, and Release use the literal matcher in one globally ordered list.
Their synchronization paths receive no companion source, so archive and delta imports save no search files.
Opening a non-QA app removes retained compressed and mapped search files and search transfers while preserving the directory, caller data, and generation identities.
The manifest stops requiring search files before cleanup removes them, allowing cleanup to resume after interruption.
An unreadable search companion can't prevent the literal directory from opening.

Apple's [build settings reference](https://developer.apple.com/documentation/xcode/build-settings-reference) defines `SWIFT_ACTIVE_COMPILATION_CONDITIONS` as compilation conditions for conditional expressions.
Selecting the verification condition as a distribution boundary is a project policy.
The actual Release bundle gate checks every app and extension file for QA markers and rejects companion resource paths even when the resource is empty.
The gate must reject a Release build with the condition added as a negative control.
The exported App Store bundle passes the same inspection.

The production website and server keep literal matching and the single ordered list.
The browser needs only the name index.
Forgiving search requires an explicit local development command.
A production deployment variable can't activate forgiving search.
Production snapshot preparation and candidate verification neither require nor publish the ranking companion.
The pinned analyzer and national quality campaign run only through explicit local forgiving-search commands.
The data checker continues validating a companion when a local bundle declares one.

## Consequences

The App Store app and production website avoid the measured companion transfer, storage, and startup costs.
Literal matching preserves the earlier written-word, region, category, and complete-number rules.
Kana readings, fuzzy retrieval, and the packed scorer remain available in QA and explicit local development.
The owner accepts losing those features in distributed builds.
The QA app uses its separate identity and App Group and keeps the phase 3 packed reader and mapped storage.

The existing proofs cover literal search decisions, ranking arithmetic, and publication transitions.
Conditional compilation, bundle composition, HTTP requests, and filesystem cleanup remain integration boundaries outside those models.
Actual build settings, literal contracts, native migration tests, bundle inspection, and contamination controls cover those boundaries.
The checks don't prove the compiler, filesystem, or linguistic accuracy.
Reconsider the distribution decision only after resource measurements support the intended shipped-device budgets.
