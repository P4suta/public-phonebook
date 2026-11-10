---
date: 2026-11-10
---

# Preserve selection in adaptive Apple navigation

## Status

Proposed.

## Context

Search and facility details must survive Duo display changes and iPad resizing.
Apple recommends [adaptive containers](https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo) and [using the iPad display](https://developer.apple.com/design/human-interface-guidelines/designing-for-ipados).

## Decision

Keep one NavigationSplitView with a typed destination and the existing query model.
Bind detail navigation's typed path so source information survives a resize.
Enable the iPad device family and its supported orientations.
Clear query and selection from the detail toolbar.
Place a SwiftUI [TextField](https://developer.apple.com/documentation/swiftui/textfield) and a labeled 44-point clear button before sidebar results.
The Duo audit rejects the system search field's small clear target.
Use public focus bindings and a native [List](https://developer.apple.com/documentation/swiftui/list) for result rows.
Follow Apple's [search-field guidance](https://developer.apple.com/design/human-interface-guidelines/search-fields) for sidebar filtering.

## Alternatives

Separate layouts can share the model but duplicate navigation rules.
A single stack leaves wide displays unused.

## Consequences

Both column configurations require UI checks and store screenshots.
Keep shared storage and privacy behavior.
Reconsider when folding or resizing breaks a task.

## Confirmation

Check search, detail, source, settings, rotation, and accessibility on iPhone, Duo, and iPad.
Inspect display changes and saved query state.
