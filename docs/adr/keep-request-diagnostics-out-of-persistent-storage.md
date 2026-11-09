---
date: 2026-11-07
---

# Keep request diagnostics out of persistent storage

## Status

Accepted.
The owner chose no data collection for the app.

## Context

The app requests public dataset updates from a Worker that persists diagnostic logs.
A retained scanner request confirms storage, but doesn't establish collection from an iPhone.
[Apple's privacy definitions](https://developer.apple.com/app-store/app-privacy-details/) distinguish transient request processing from off-device data retained beyond the request.

## Decision

Turn off observability, persistent logs, traces, real-time Issues, Logpush, and tail consumers in the [service configuration](../../cloudflare.config.ts).
Set persistence and export destinations explicitly.
[Cloudflare's configuration reference](https://developers.cloudflare.com/cf/projects/config-explorer/) defines the controls.
Keep query redaction, request admission, rate limits, and public uptime checks.
Keep the App Privacy response at no data collection and discard the unpublished diagnostic-data draft.

## Alternatives

Retaining diagnostics would help debugging, but conflicts with the owner's choice.

## Consequences

Incident investigation loses stored request context.
The change doesn't erase historical records or control Cloudflare's independent security processing.
The dashboard can leave inactive persistence defaults in API responses.
Worker-wide settings need a separate production change.

## Confirmation

Check the typed configuration and require inactive production channels without export destinations or tail consumers.
