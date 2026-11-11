---
date: 2026-11-10
---

# Keep search beside details when columns fit

## Status

Proposed.

## Context

iPhone Air needs adjacent search and details without losing native back navigation.

## Decision

Store the query and one route path in the parent view.
Narrow windows use search as a native stack root.
At regular width and height, keep a stable native split view.
Compact windows with room for both columns use adjacent native stacks.
Bind the remaining routes to the detail stack.
Accept path changes from the active container.
Inactive containers expose empty native paths.
Setup uses native stacks.
Wrap enlarged text within the columns.
Follow Apple's [layout guidance](https://developer.apple.com/design/human-interface-guidelines/layout) and [navigation stack contract](https://developer.apple.com/documentation/swiftui/navigationstack).
Use the system's [split view adaptation](https://developer.apple.com/documentation/swiftui/navigationsplitview) in regular windows.

## Alternatives

The native split view can collapse or overlay columns at iPhone widths.
Adjacent stacks replace native split behavior.
Replacing the navigation root loses native history and transitions.

## Consequences

Resizing can change the container.
Reconsider compact columns when the system supports persistent columns at iPhone widths.

## Confirmation

Verify back gestures, partial cancellation, rotation, and clearing on iPhone Air, iPhone, Duo, and iPad.
Keep the query, selection, and nested route through resizing and enlarged text.
Verify native dialogs remain open during text audits.
