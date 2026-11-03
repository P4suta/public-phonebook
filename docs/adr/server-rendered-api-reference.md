---
date: 2026-11-02
---

# Render the API reference on the server from the OpenAPI document

## Status

Superseded by [serving the directory JSON to the site only](serve-directory-json-to-the-site-only.md).
The `/developers` page, its request form, and the OpenAPI documents are gone.
Proposed.
Implemented locally.
It supersedes the [interactive reference decision](openapi-driven-interactive-reference.md).

## Context

The Scalar reference loaded about 4.5 MB of JavaScript on `/developers`.
A Lighthouse 13.6 run on the local preview scored the page at 57 for mobile performance and 74 for desktop performance.
Every other page scored 98 to 100.
The page also needed 35 `!important` overrides, a PostCSS palette filter, an accessibility repair adapter, and an inline-style exception in its CSP.
Without JavaScript, the page offered only the raw OpenAPI document.
External developers still need discoverable operations, parameters, response meanings, code examples, and a way to send a request.

## Decision

Render the reference on the server from the service's own `/api/openapi.json` in the route loader.
The server reads the document in process, so the page needs no extra round trip.
A pure model in `src/core/api-reference.ts` reads only the parts of the document that the page presents.
It refuses what the page can't present faithfully.
That covers non-GET operations, header and cookie parameters, undeclared path parameters, duplicate operation IDs, and a parameter named `operation`.
Operations appear in document order, grouped by their first tag.
A navigation list sits beside the content on wide screens and before it on narrow screens.
Each operation has its method and path as a heading, a Japanese summary, a parameter table, response meanings, curl and JavaScript examples, and a request form.

Each request form is a plain GET form to `/developers` that names its operation in `operation`.
Without JavaScript, the loader sends the request to the API in process and renders the status and body below the form.
With JavaScript, the form sends the same request from the browser without credentials and shows the result without navigating.
`referenceRequestDecision` in `src/core/reference-request-policy.ts` decides whether a request is sent.
It sends only a documented operation whose path values are nonempty and aren't dot segments.
Path values are percent-encoded so they stay in their segment, and only the operation's own parameters reach the request.
The page shows at most 64 KiB of a text body and never shows a binary body.

Japanese summaries, group names, and status meanings live in `src/ui/api-reference-copy.ts`.
They're keyed by operation ID, tag, and status code.
The OpenAPI document stays English and unchanged, because the iOS contract tests read it.
`showsContractText` shows each operation's English summary and description beside its Japanese summary.
Parameter and response descriptions stay English, because the document has no other text for them.

The page uses the same CSP as every other page.
Style elements need the request nonce, and the single hashed style attribute stays the only attribute exception.
The page loads no third-party code and makes no third-party requests.

## Consequences

The page loads no reference bundle beyond its route chunk, and its content is visible before scripts run.
The palette filter, the `!important` overrides, the accessibility adapter, the Zod configuration, and the CSP exception are gone.
The reference drops Scalar's operation search, its schema browser, and its retry action for an unavailable document.
The full schemas stay available in the linked OpenAPI document.
A new operation needs a Japanese summary, and a unit test fails until it has one.
The page renders what the document describes, so an operation missing from the document is missing from the page.

The proved decision covers whether a request is sent, not how the page renders.
Browser tests cover the rendered operations, direct links, copying, the form with and without JavaScript, the CSP, and the palette.

Keeping Scalar would keep the bundle, the palette filter, and the style exception.
A page generated at build time would need the same request handler and could drift from the running contract.
Swagger UI and other client-side viewers would bring back the bundle and the palette adapter.
