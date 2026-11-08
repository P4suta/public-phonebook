---
date: 2026-11-08
---

# Keep production free of diagnostic output

## Status

Proposed.

## Context

The owner excludes production diagnostic logs and usage analytics from the service's privacy policy.
Server console messages and native unified logging still emit diagnostics.

## Decision

Remove server runtime console output.
Compile native logs and signposts only with `PHONEBOOK_VERIFICATION_TOOLS`.
Keep explicit QA measurements and project test output local.
Preserve failure responses, visible status, retries, and generation receipts.
Keep Cloudflare log and trace collection off.

The owner policy excludes production output even where [Apple recommends diagnostic logging](https://developer.apple.com/documentation/os/generating-log-messages-from-your-code).

## Alternatives

Redacting private fields retains operational evidence but still collects diagnostics contrary to the owner's policy.
An opt-in production uploader adds collection and consent behavior the service doesn't need.

## Consequences

Historical production failures may remain unexplained without a deterministic reproduction.
QA builds keep explicit local checks without adding production telemetry.
Platform-managed diagnostics remain outside the app's control.

## Confirmation

Require silent server failure tests, rejecting source fixtures, and diagnostic markers present in QA binaries and absent from Release binaries.
Reconsider only after an explicit owner policy change.
