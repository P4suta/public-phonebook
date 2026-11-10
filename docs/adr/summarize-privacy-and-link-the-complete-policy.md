---
date: 2026-11-11
---

# Summarize privacy and link the complete policy

## Status

Proposed.

## Context

The owner wants brief privacy explanations.
The apps process searches locally, while browser fallback requests and support email have different data flows.

## Decision

Show a short app collection summary and a link to the shared policy.
Keep browser requests, delivery providers, local storage, deletion, and support email explicit in concise policy sections.
Apple's [privacy guidance](https://developer.apple.com/app-store/review/guidelines/#privacy) requires a policy link inside the app and clear terms for data use and deletion.
Its [collection definition](https://developer.apple.com/app-store/app-privacy-details/#data-collection) distinguishes on-device processing and transient request handling from retained collection.
Keep runtime behavior unchanged.
Keep provider disclosures under Cloudflare's [data processing terms](https://www.cloudflare.com/cloudflare-customer-dpa/).

## Alternatives

Duplicating the complete policy in each app adds reading and maintenance costs.
A service-wide collection denial would obscure browser requests and support email.

## Consequences

The complete policy requires a network connection.
Search remains available offline.
Reconsider the summary whenever data handling changes.

## Confirmation

Check collection scope with the existing network and privacy tests.
Verify readable summaries, policy links, external-action cancellation, and required disclosures across platforms.
