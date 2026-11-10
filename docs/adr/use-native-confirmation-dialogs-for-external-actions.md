---
date: 2026-11-10
---

# Use native confirmation dialogs for external actions

## Status

Proposed.

## Context

Opening a public facility in Maps or a browser requires an explicit confirmation with a readable destination disclosure.
The app used alerts for intentional actions, and custom modal sheets added layout and accessibility behavior to maintain.

## Decision

Use SwiftUI `confirmationDialog` for map and external-link actions.
Apple's [action sheet guidance](https://developer.apple.com/design/human-interface-guidelines/action-sheets) recommends the native presentation for choices related to an intentional action.
Keep the existing disclosure and explicit Open and Cancel actions.
Let the system adapt presentation and dismissal to iPhone and iPad.
Keep failure alerts for unavailable map destinations.

## Alternatives

Custom sheets provide full layout control but duplicate system presentation behavior.
Opening immediately removes the required confirmation.

## Consequences

The operating system owns action layout and adaptive presentation.
Reconsider the presentation when external actions require user input.

## Confirmation

Verify readable disclosures, cancellation, action targets, and rendered text growth on iPhone, Duo, and iPad.
Run the full audit on app screens and preserve the system dialog's existing Dynamic Type exception.
