---
date: 2026-11-02
---

# Search in the browser once the index loads

## Status

Accepted.
The owner approved this direction in the plan for on-device search, and this change implements it.
It adopts the [name-ordered search index](publish-a-name-ordered-search-index-for-the-website.md).

## Context

The website sent each search to the server, so the server learned every term a reader typed.
Japanese input still sent a request after each conversion or deletion.
The published index carries the names, categories, regions, and telephone numbers of every contact in server order.
The index is about 7 MiB with Brotli, which is too large to block the first search on a slow connection.
Readers without JavaScript need the same search, and the public API and D1 stay in service.
The iPhone app has no filters and shows addresses only in details.

## Decision

Render the first page on the server, and keep the server search for readers without JavaScript.
After the first render, fetch the index location and load the index in a dedicated Web Worker.
Don't start the load when the browser asks to save data.
Keep the server search and its trigger policy until the Worker admits the index.
Admit the index only when its decoded length, SHA-256, format line, and snapshot match the location.
Fall back to the server search for the rest of the page when any check fails or the load fails.

Once the index is ready, search in the Worker on each input, except while an input method is composing.
Keep the server's ranking, three previews per category, and continuations of 30.
Replace server results with device results in place, so the visible rows and focus stay.
Keep a page that a server cursor continued on the server, because the device can't decode that cursor.

Open a device result through `/contacts/row/{snapshot}/{row}`, which resolves the row on the server.
When that lookup reports a changed snapshot, reload the index and search again.
Serve the index from an immutable URL with `Content-Encoding: br`, and rely only on the browser's HTTP cache.
Don't store the index or search terms in IndexedDB, Cache Storage, or a Service Worker.

Remove the region and category filters from the website.
Redirect search URLs with `prefecture` or `municipality` to the URL without them, and drop a cursor issued for those filters.
Keep `category` and `cursor` as the continuation state of a search without JavaScript.

## Consequences

After the index loads, typing and continuations send no request, so search terms stay in the browser and search works offline.
Before the index loads, without JavaScript, and with data saving, search terms still reach the server.
Opening a facility still tells the server which facility the reader chose.
The first visit downloads 7,246,869 bytes for the national snapshot, and later visits in the same snapshot use the HTTP cache.
The Worker decodes 41,067,471 bytes for that snapshot and keeps every row in its memory.
Readers can no longer narrow a search by region or category on the website, and the public API keeps those filters.
The browser tests serve the built Worker from workerd over HTTPS, because WebKit advertises Brotli only over HTTPS and the Vite preview decodes the body.
Rejected alternatives were a Service Worker or IndexedDB copy, which would keep data beyond the HTTP cache and need their own eviction, and decoding Brotli in JavaScript, which browsers don't support uniformly.
