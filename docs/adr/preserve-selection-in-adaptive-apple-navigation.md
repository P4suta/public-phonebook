---
date: 2026-11-10
---

# Preserve selection in adaptive Apple navigation

## Status

Proposed.

## Context

Search and facility details must survive resizing.
Air rotation checks reach their 600-second guard while XCTest awaits animation completion.

## Decision

Keep one [NavigationSplitView](https://developer.apple.com/documentation/swiftui/navigationsplitview) alive with a [typed detail stack](https://developer.apple.com/documentation/swiftui/navigationstack).
Keep the sidebar visible when both columns fit.
Remove the sidebar toggle from the [sidebar's toolbar](https://developer.apple.com/documentation/swiftui/view/toolbar(removing:)).
Give the split container a [regular horizontal size class](https://developer.apple.com/documentation/swiftui/environmentvalues/horizontalsizeclass) when two 320-point columns fit.
Use compact otherwise.
Keep the query model, native List, focus bindings, and labeled 44-point clear action.

## Alternatives

Three root containers keep the current appearance but duplicate navigation ownership.
Unmodified size classes collapse wide iPhones.
A hideable sidebar gives details more room but obscures search.

## Consequences

The size-class override affects descendant layouts.
System containers own transitions and [Duo resizing](https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo).
Keep shared storage and privacy behavior.
Reconsider when folding or resizing breaks a task.

## Confirmation

Check search, detail, source, settings, rotation, clear, gestures, keyboard focus, and accessibility on iPhone, Duo, and iPad.
Capture sample-city screens.
Reconsider if resizing breaks a task.
