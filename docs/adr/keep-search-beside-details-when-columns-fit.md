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
Wide windows use two native stacks with the selected route as the detail root.
Bind the remaining routes to the detail stack.
Use native stacks for setup steps.
Scale column widths with Dynamic Type.
Follow Apple's [layout guidance](https://developer.apple.com/design/human-interface-guidelines/layout) and [navigation stack contract](https://developer.apple.com/documentation/swiftui/navigationstack).

## Alternatives

The native split view can collapse or overlay columns at iPhone widths.
Replacing the navigation root loses native history and transitions.

## Consequences

Large text can require one column.
Reconsider adjacent stacks if the system split view supports persistent columns at the required widths.

## Confirmation

Verify back gestures, partial cancellation, rotation, and clearing on iPhone Air, iPhone, Duo, and iPad.
Keep the query, selection, and nested route through resizing and enlarged text.
