---
date: 2026-11-08
---

# Keep validated search columns compact

## Status

Proposed.

## Context

The [browser search](search-in-the-browser-once-the-index-loads.md) loads the national name index.
Complete row objects duplicate data before any query.
Experimental byte views defer validation and reconstruct comparison names during literal scans.

## Decision

Keep format 1 and validate every row before admission.
Keep comparison names, category bytes, region indexes, and line offsets.
Read display names and telephone arrays from byte views when results need them.
Exact telephone lookup checks token boundaries.
UTF-8 decoding stays fatal under the [Encoding Standard](https://encoding.spec.whatwg.org/#dom-textdecoder-decode).

The ordinary decoder stays available for publication checks and independent comparisons.
Literal matching reads columns without constructing result rows.

## Alternatives

Complete objects simplify scans but keep redundant objects and strings.
Experimental views save storage but repeat normalization and weaken admission.
A changed artifact needs publication and compatibility work without addressing the existing decoder.

## Confirmation

Require identical corruption rejection, generated search results, national ordering, and browser fault tests.
Compare national startup, search latency, and memory before and after the change.

## Consequences

Offsets and comparison strings still consume memory.
Reconsider the representation if measured admission or memory costs exceed the browser budgets.
