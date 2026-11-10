---
date: 2026-11-10
---

# Delegate search to the paired iPhone

## Status

Proposed.

## Context

Apple Watch needs brief facility searches and readable telephone numbers.
The iPhone stores the national directory.
The owner selected iPhone-backed search.

## Decision

Send versioned requests and replies with size bounds through [Watch Connectivity](https://developer.apple.com/documentation/watchconnectivity).
Search the saved generation through an independent adapter.
Keep the phone's visible query unchanged.
Return ten results with telephone numbers and source information.
Associate each reply with its request and reject stale or malformed data.
Keep downloads, diagnostics, and analytics out of the Watch app.

## Alternatives

A Watch-local directory would support independent searches but duplicate storage, imports, and updates.
A web service would remove the iPhone dependency but send search terms to the service.

## Consequences

New searches require a reachable paired iPhone with a prepared directory.
Show connection and preparation failures with a retry action.
Keep the last successful result readable.
Reconsider if people need independent searches.

## Confirmation

Run contract and saved-directory tests, paired simulator messaging, watchOS UI checks, and native package verification.
