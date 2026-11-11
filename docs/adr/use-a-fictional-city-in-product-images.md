---
date: 2026-11-10
---

# Use a fictional city in product images

## Status

Accepted.
The owner selected the sample setting in [issue #413](https://github.com/P4suta/public-phonebook/issues/413).

## Context

Product images need recognizable examples without suggesting endorsement by real facilities or exposing personal information.
[Apple recommends screenshots showing the app in use](https://developer.apple.com/app-store/review/guidelines/#accurate-metadata).

## Decision

Use the fictional city `みほん市` and reference facility `みほん市民図書館` for public screenshots, previews, demonstrations, and other product illustrations across platforms.
Keep future assets in the same setting.
Capture the actual interface with sample names, addresses, dates, publishers, and telephone placeholders.
Identify sample content within the displayed data.
Use reserved example domains for facility and source links, following [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606.html).
Keep production data and behavior unchanged.

## Alternatives

Real directory captures show current coverage but can imply affiliation and change with the dataset.
Keep real data for private correctness and performance QA.

## Consequences

Maintain a shared sample fixture and reject live-data substitution during public-image capture.
Images show behavior rather than national coverage.
Reconsider the setting if product scope requires another consistent fictional context.

## Confirmation

Fixture checks reject live-data overrides.
Simulator captures from the production configuration show the sample city on iPhone, Duo, iPad, and Watch.
