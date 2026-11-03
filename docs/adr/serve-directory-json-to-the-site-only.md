---
date: 2026-11-03
---

# Serve the directory JSON to the site only

## Status

Accepted.
The [dataset file formats decision](declare-dataset-file-formats-instead-of-api-versions.md) supersedes its `/api/v1` index, version header, and versioned listings.
The owner decided to retire the public read API.
This supersedes the [public read API](public-read-api-with-snapshot-identity.md), the [server-rendered API reference](server-rendered-api-reference.md), and the [interactive reference](openapi-driven-interactive-reference.md).

## Context

The site documented a public read API at `/developers` and published two OpenAPI documents.
Search, contact, source, catalog, and search index routes answered under both `/api` and `/api/v1`.
Their cross-origin headers let a page on any site read them.
The complete dataset files already give everyone the same records, provenance, and reuse terms.
Removing only the documentation would leave the same routes open to whoever found them.
The owner rejected that outcome as unfair to everyone who never learns of the routes.
The iPhone app reads only the `/api/v1` index, the dataset and delta listings, and their files.
Server rendering calls the site routes in process with a request that carries no fetch metadata.

## Decision

Split the API into two route families with disjoint paths.

The open-data family holds the `/api/v1` index, the dataset listing and files, and the delta listing.
The listings and files answer under both `/api/v1` and `/api`.
The family keeps its cross-origin headers, the version header, and the snapshot pins of the versioned index and listings.
The index links only the dataset and delta listings.

The site family holds search, category previews, contacts, single vCards, sources, the catalog, the search index, and the row locator.
These routes answer only under `/api`.
They send no cross-origin headers and answer `OPTIONS` with 405.
Search accepts page sizes from 1 through 30, the page size that the site requests.
`siteRequestAdmission` in `src/core/site-request-policy.ts` refuses a site-route request whose `Sec-Fetch-Site` header is present and differs from `same-origin`.
The refusal is a 403 problem with the code `cross_origin`.
A request without the header stays admitted, because server rendering and the release checks send none.
Dafny proves the admission and the page bound, and a negative control for each requires the proof to fail after a mutation.

Remove `/developers`, both OpenAPI documents, the reference request form and its proof, the filtered bulk vCard route, and the `hono-openapi` dependency.
List the complete files on the data page with their format, size, SHA-256, and download link.
Keep [the open data guide](../api.md) at its path, because the native delta reader and an earlier decision cite its format sections.
Extend the zone's limit of 60 requests in 10 seconds per client to the remaining site routes and the facility pages.

## Consequences

Header checks stop other sites' pages, because browsers attach `Sec-Fetch-Site` to every request that a page makes.
The zone rate limit stops everything else, including scripts that omit the header.
Open data stays equal for all, because every client gets the same complete files and listings.
A reader who types a site route into the address bar gets 403, because the browser then sends `Sec-Fetch-Site: none`.
The vCard and source record links on the site's own pages still work, because those requests are same-origin.
Clients of the retired search API need to switch to the complete files.
The iPhone app reads the same index fields and files, and its provider contract tests pass without app changes.
The data page now needs a bound dataset manifest, like the dataset listing.
Rejected alternatives were removing only the documentation, which left the routes open to whoever found them, and keys or accounts, which would add secrets to a public service.
