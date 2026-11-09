---
date: 2026-11-08
---

# Admit browser search in bounded work batches

## Status

Proposed.

## Context

National admission passes its latency budget but exceeds the added process-memory budget.
Retained JavaScript heaps explain only part of the observed resident size.
Synchronous validation also delays cancellation of an obsolete load.

## Decision

Expose validated name batches through a generator while retaining synchronous decoder entry points.
The browser adapter yields through a [message channel](https://html.spec.whatwg.org/multipage/web-messaging.html#message-channels) between batches and checks the load generation before continuing.
Publish an index only after every batch and reference passes validation.
Keep the wire format and admission budgets unchanged.

## Alternatives

A synchronous scan is simpler but monopolizes the Worker until admission ends.
Forced garbage collection isn't a browser app API and can't establish production memory behavior.
Timer yields introduce timer clamping.

## Consequences

Scheduling becomes an adapter concern.
Stale loads can stop without replacing the active index.
Runtime collection remains an empirical boundary.

## Confirmation

Require synchronous equivalence, final-batch rejection, obsolete-load cancellation, national parity, and all four measured budgets.
Keep the change only if the experiment supports its memory benefit.
