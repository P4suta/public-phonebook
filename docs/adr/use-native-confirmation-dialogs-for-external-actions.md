---
date: 2026-11-10
---

# Use native alerts before external handoffs

## Status

Proposed.

## Context

External actions require confirmation with a readable destination disclosure.
The confirmation popover places Open outside the visible window on the Duo simulator running build 24B91016s.

## Decision

Use SwiftUI alerts for binary consent before map and external-link handoffs on iPhone and iPad.
Use a short title, the destination disclosure, and explicit Open and Cancel actions.
Apple's [Alerts guidance](https://developer.apple.com/design/human-interface-guidelines/alerts) permits confirmation of important initiated actions.
Treat leaving the app and sending the disclosed data as requiring prior consent.
Keep failure alerts for unavailable map destinations.

## Alternatives

Apple recommends [action sheets](https://developer.apple.com/design/human-interface-guidelines/action-sheets) for related action choices.
The current popover can leave confirmation inoperable on Duo.
Custom sheets duplicate system behavior, and immediate opening removes prior consent.

## Consequences

Alerts interrupt the task before handoff.
Reconsider the presentation if the flow adds alternative actions or removes prior consent.

## Confirmation

Verify disclosures, cancellation, visible action targets, and enlarged text on iPhone, Duo, and iPad.
Audit app content and native confirmations in both appearances.
