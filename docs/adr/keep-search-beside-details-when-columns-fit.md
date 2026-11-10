---
date: 2026-11-10
---

# Keep search beside details when columns fit

## Status

Proposed.

## Context

The owner needs search results beside facility details on wide iPhone windows.
The collapsed sidebar obscures the selected facility.

## Decision

Keep the system split view in regular horizontal size classes.
In compact size classes, use two adjacent navigation stacks when both columns fit, and one stack otherwise.
Scale column widths with Dynamic Type.
Preserve the query, selection, and detail path in the parent view.
Apple's [layout guidance](https://developer.apple.com/design/human-interface-guidelines/layout) recommends adapting to available space and retaining features through size changes.
Preserve native navigation and dialogs with monochrome search controls.

## Alternatives

The collapsed sidebar adapts automatically but retains the overlay.
One stack prevents comparison with search results.

## Consequences

Compact navigation needs a return to search preserving the query.
Large text can require one column even in a wide window.
Reconsider the custom compact layout if the system split view supports persistent columns at the required widths.

## Confirmation

Verify visible, usable columns, matching control borders, and retained query, selection, and source navigation through rotation.
Verify narrow windows, enlarged text, light and dark appearances, and clearing from search and details.
