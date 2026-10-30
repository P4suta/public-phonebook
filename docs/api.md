# Public read API

This document describes the local TypeScript implementation.
The existing public deployment is unchanged.
The running API describes its contract at `/api/openapi.json`.
Open `/developers` for the locally bundled Scalar reference, operation search, code examples, and interactive requests against the current API.
The viewer reads the generated contract rather than maintaining a second list of operations.
No API key, cookie, account, or HTML scraping is required.

## Discover and search

Start with `GET /api` and `GET /api/catalog`.
The catalog supplies category IDs, prefecture codes, municipality codes, counts, and the current snapshot.

```sh
curl --fail-with-body --get --data-urlencode 'q=国立国会図書館' http://127.0.0.1:8787/api/contacts
```

| Parameter | Contract |
| --- | --- |
| q | A facility-name substring or complete Japanese telephone number; at most 512 UTF-8 bytes |
| prefecture | Two-digit code from the catalog |
| municipality | Five-digit code from the catalog; implies its prefecture |
| category | One of the catalog's category IDs |
| limit | Integer from 1 through 100; defaults to 30 |
| cursor | Opaque continuation token; prefer the returned next link |

Parameters occur at most once.
Unknown parameters, malformed encoding, and conflicting regions are rejected.
Names use NFKC normalization and case folding through JavaScript lowercase conversion.
Exact names precede prefixes and substrings.
Ties use the normalized name and stable ID in SQLite binary order.
Complete telephone numbers use the canonical Japanese E.164 index.
Shared telephone numbers preserve separate contact records.
Telephone search accepts national or `+81` spelling, full-width digits, and explicit visual separators.
It does not extract numbers from labels, internal line breaks, extensions, or lists of numbers.
The current directory contract admits 10- and 11-digit national numbers rather than emergency short codes or longer device-number allocations.
Telephone aliases share a cursor identity without colliding with similarly normalized facility-name queries.

A successful search returns `data`, `meta`, and `links`.
Follow `links.next` until it is null.
Each cursor binds the snapshot, normalized query, filters, and page size.
A changed snapshot returns 409; restart without the cursor.
Query identities are SHA-256 digests rather than copies of the query text.

## Preview facility categories

`GET /api/contact-groups` accepts the same search parameters.
Without a selected category, it returns every matching category with up to `min(3, limit)` contacts and an exact matching count.
Groups follow the order of their best contact under the same stable search ranking.
The response contains `groups: [{ category, results }]` and overall `meta: { snapshot, total }`.
Each `results` has the flat search response shape, and its `links.self` identifies the containing preview request.
Follow each `results.links.next` through `/api/contacts` to retrieve all remaining contacts in that category.
The continuation retains the requested page size, even when the initial preview contains only three contacts.
A selected category returns a regular page wrapped in one group.
A cursor without a category is rejected.
Category membership, disjoint contact identities, snapshot consistency, and the sum of category totals are validated at both service and client boundaries.
This endpoint supports bounded category previews without downloading the national database or issuing a request for every category.

## Read a contact and its sources

`GET /api/contacts/{id}` returns all telephone numbers, address, website, source URLs, source record identity, dates, and reuse metadata.
`GET /api/contacts/{id}/contact.vcf` returns one complete vCard 3.0.
`GET /api/sources` and `GET /api/sources/{id}` expose retained source hashes, retrieval dates, artifacts, and import accounting.
A source date describes the retained publication and does not assert telephone reachability.
Each phone retains the publisher's spelling in `display` and its canonical dial destination in `e164`.
Validation requires both fields to identify the same digits.
The website formats and copies the canonical value with Japanese numbering metadata while the API and archives preserve the original spelling.

## Download complete data

`GET /api/datasets` supplies the current manifest.
It lists complete gzip-compressed JSONL, CSV, and vCard files with byte lengths and SHA-256 hashes.
Use each returned URL directly.
The URL includes both the contact snapshot and the archive digest, so a changed representation gets a different immutable URL.
Validate the downloaded byte length and SHA-256 before processing it.
Downloads contain the complete directory and do not depend on the search page size.
Source-specific reuse terms remain attached to every record.
CSV cells beginning with spreadsheet formula characters receive a leading apostrophe.
CSV generation uses the pinned `csv-stringify` serializer with quoting, CRLF records, and its formula-escaping option.
JSONL retains the canonical structured values.
vCard text is escaped and folded at 75 UTF-8 bytes without splitting code points.

## HTTP behavior

GET, HEAD, and OPTIONS are supported.
Other methods return 405.
Public CORS permits anonymous reads and exposes validators, snapshot identity, request IDs, continuation links, and retry information.
Catalog ETags identify the serialized catalog representation.
Immutable archive URLs carry ETags and support conditional reads.
Errors use RFC 9457 `application/problem+json` with `code`, `status`, and a generated `requestId`.
400 denotes invalid input, 404 a missing resource, 409 an obsolete cursor snapshot, and 503 temporary unavailability.
A 503 response includes Retry-After.
Error bodies omit SQL, stack traces, credentials, and user queries.
