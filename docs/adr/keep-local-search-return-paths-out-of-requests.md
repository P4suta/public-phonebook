---
date: 2026-11-08
---

# Keep local search return paths out of requests

## Status

Proposed.

## Context

Local result links put the query inside the `from` parameter of facility URLs.
Opening a facility sends the query despite the promise of local search after admission.
`Referrer-Policy: no-referrer` can't remove a query embedded in a destination URL.

## Decision

Carry local return paths in URL fragments through facility and source pages.
User agents separate [URI fragments](https://www.rfc-editor.org/rfc/rfc3986#section-3.5) before dereferencing.
Accept only the root search route and validated search parameters.
Return through a root fragment, and restore the query after local admission or an explicit fallback state.
Keep server navigation and shared URLs working.
Delay fragment-dependent links with [`ClientOnly`](https://github.com/tanstack/router/blob/main/docs/router/api/router/clientOnlyComponent.md) until hydration.
Provide ordinary links inside `noscript`.

## Alternatives

Dropping the return path loses the previous search.
Browser storage adds persistence and fails when browsers block storage.
Client navigation alone still exposes return paths when readers open links in another tab.

## Consequences

Fragments remain visible in the address and browser history.
Without JavaScript, a local return link opens the empty search page.

## Confirmation

Inspect facility, source, and return requests with encoded queries.
Reject invalid return paths.
Reconsider if the search route changes.
