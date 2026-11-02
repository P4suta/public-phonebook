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
It lists complete gzip-compressed JSONL, CSV, and vCard files and a Brotli-compressed native directory archive with byte lengths and SHA-256 hashes.
Use each returned URL directly.
The URL includes both the contact snapshot and the archive digest, so a changed representation gets a different immutable URL.
Validate the downloaded byte length and SHA-256 before processing it.
Downloads contain the complete directory and do not depend on the search page size.
Source-specific reuse terms remain attached to every record.
CSV cells beginning with spreadsheet formula characters receive a leading apostrophe.
CSV generation uses the pinned `csv-stringify` serializer with quoting, CRLF records, and its formula-escaping option.
JSONL retains the canonical structured values.
vCard text is escaped and folded at 75 UTF-8 bytes without splitting code points.

### Native directory archive

`directory.tsv.br` carries the complete directory in a compact form for offline clients.
The server sends its exact bytes as `application/octet-stream` without `Content-Encoding`, so a client verifies the SHA-256 before decompressing it with Brotli.
The decompressed archive is UTF-8 text with LF line endings and no byte order mark.
Line 1 is `public-phonebook-directory`, a TAB, and the format version `1`.
Line 2 is a one-line JSON header with `snapshot`, `generatedAt`, `contacts`, `categories`, `prefectures`, `municipalities`, `sources`, `provenances`, and `links`.
`categories`, all 47 `prefectures`, and `municipalities` copy the snapshot catalog, without the category counts.
`sources` lists the `id`, `url`, and any `publisher` or `title` of each source that a provenance references.
Each provenance holds a `source` index and the `license`, `licenseUrl`, `dataAsOf`, and `retrievedAt` its contacts share.
`links` is the dictionary of source and confirmation URLs.
Sources follow `id`, provenances follow `source` and then their text fields, and links follow their value, all in ascending UTF-8 order without duplicates.
Every source, provenance, and link is referenced at least once.
Each following line is one contact with nine TAB-separated fields.

| Field | Content |
| --- | --- |
| 1 | Index into `categories` |
| 2 | Five-digit municipality code, or the two-digit prefecture code when the municipality is unknown |
| 3 | Name |
| 4 | Address as in JSONL |
| 5 | Telephones joined by U+001F |
| 6 | Website, or empty |
| 7 | Index into `provenances` |
| 8 | Indices into `links` for the source URLs, joined by U+001F |
| 9 | Empty for an unconfirmed telephone, `*` for a confirmation without a URL, or the index into `links` of the confirmation URL |

The national number is `0` followed by the E.164 digits after `+81`.
A telephone is its publisher's spelling when the ASCII digits of that spelling equal the national number.
Otherwise it is the national number, U+001E, and the spelling.
Indices are decimal without leading zeros.
Text fields never contain TAB, LF, CR, U+001E, or U+001F.
Rows are sorted by their UTF-8 bytes, identical rows may repeat, and the last row ends with LF.
The header's `contacts` and prefecture counts equal the rows.
The archive omits contact and source-record IDs, which remain in JSONL.

### Native directory deltas

A delta rebuilds the current decoded `directory.tsv.br` from the decoded archive of an earlier snapshot, so an offline client can skip the complete download.
`GET /api/dataset-deltas` lists the deltas to the current snapshot, and `/api/datasets` doesn't list them.
The versioned `GET /api/v1/dataset-deltas?snapshot=…` takes the same snapshot pin as the other versioned resources and returns 409 after a change.
Each discovery document links the listing as `datasetDeltas`, and the `/api/v1` link carries the pin.
The response holds the current `snapshot`, the `archiveSha256` of the `directory.tsv.br` that every delta rebuilds, and a `deltas` array that may be empty.
Each entry names its `base` snapshot, the `baseArchiveSha256` of that snapshot's `directory.tsv.br`, its `file` and `url`, and the `bytes` and `sha256` of its Brotli bytes.
It also gives the `uncompressedBytes` and `uncompressedSha256` of the decoded delta, so a client can bound its decoder.
The listing revalidates like the dataset manifest.
The URL serves the exact Brotli bytes as `application/octet-stream` without `Content-Encoding`, with the immutable caching of the complete files.
The file is `directory-delta-` followed by the base snapshot and `.tsv.br`.
Preparation publishes a delta only when its Brotli bytes are at most half of the complete archive's, and keeps at most 12 of them.

The decoded delta is UTF-8 text with LF line endings and no byte order mark, and its last line ends with LF.
Line 1 is `public-phonebook-directory-delta`, a TAB, and the format version `1`.
Line 2 is a one-line JSON header.

| Key | Content |
| --- | --- |
| `base`, `target` | The `snapshot`, the `archiveSha256` of its `directory.tsv.br`, the `sha256` and `bytes` of the decoded archive, and its `contacts` |
| `kept` | Rows copied from the base |
| `added` | Literal rows |
| `removed` | Base rows that no copy names; `kept + removed` is the base's `contacts` |
| `categories`, `provenances`, `links` | One entry per base dictionary index, holding the target index or `null` |

`kept + added` is the target's `contacts`, and the two snapshots differ.
Line 3 is the target archive's line 2, byte for byte.
Every following line is one instruction, in the order of the rebuilt rows.
`=`, a TAB, a 0-based base row position, a TAB, and a positive count copy that many consecutive base rows.
`+`, a TAB, and an archive row add that row as written.
Positions and counts are decimal without leading zeros, every copy lies inside the base, and no two copies overlap.

A copied row keeps fields 2 through 6.
Field 1 becomes the `categories` entry for its index.
Field 7 becomes the `provenances` entry for its index.
Each index in field 8, and the index in field 9 when it isn't empty or `*`, becomes its `links` entry.
A `null` or an index outside the target header's dictionary rejects the delta.
The maps aren't identities: a recollection that only changes retrieval times maps each old provenance to its new one, so those rows stay copies.

To apply a delta, start from the client's stored rows of the base snapshot in archive order.
Check the listed digest and length of the delta file, then line 1 and the header.
Check that `base` names the stored snapshot, its row count, and its dictionary sizes, and, when the client kept them, the decoded digest and length.
Write line 1 of the archive format, a LF, line 3 of the delta, and a LF.
Then write each rebuilt row followed by a LF, in instruction order, and hash those bytes as they're written.
The result is the target only when its rows equal `target.contacts`, and its bytes and SHA-256 equal `target.bytes` and `target.sha256`.
Validate the rebuilt archive as a complete one before replacing stored data.
After any failure, keep the stored data and download the complete `directory.tsv.br`.

## Website search index

The website's search index is a website contract rather than a public download.
`/api/datasets` doesn't list it, and the versioned `/api/v1` API doesn't serve it.
`GET /api/search-index` returns the current `snapshot`, the immutable index `url`, and the `bytes` and `sha256` of the Brotli bytes.
It also returns the `uncompressedBytes` and `uncompressedSha256` of the decoded index.
The response revalidates with an ETag, like the catalog.

`GET /api/search-index/{snapshot}/{sha256}` returns the stored Brotli bytes with `Content-Encoding: br`, so the HTTP client decodes them.
The decoded bytes are `search-index.br` format 1, which [the search index decision](adr/publish-a-name-ordered-search-index-for-the-website.md) describes.
Only the current snapshot and the current digest exist, and any other pair returns 404.
A request returns 406 unless its `Accept-Encoding` names `br`, or `*`, with a nonzero weight.
Cloudflare rewrites `Accept-Encoding` before the Worker runs, so the Worker first reads the visitor's own value from `cf.clientAcceptEncoding`.
When neither value reaches the Worker, it also returns 406, because the index has no unencoded representation.
The response carries the digest as a strong ETag, answers a matching `If-None-Match` with 304, and is cached for a year as immutable.
Its `Content-Type` is `application/octet-stream`, because the decoded index mixes UTF-8 lines with binary category and region parts.
Check the decoded length, the decoded SHA-256, the format line, and the header snapshot before using the index.

## Locate a contact by index row

`GET /api/contacts/row/{snapshot}/{row}` returns `{ "id": "…" }` for a 0-based row of that snapshot's search index.
The row is a decimal number without a sign or leading zeros.
D1 numbers contacts in index order, so row `n` is the contact whose D1 rowid is `n + 1`.
A malformed snapshot or row returns 400, a snapshot that isn't current returns 409, and a row at or past the contact count returns 404.
A 409 response names the current snapshot in `X-Dataset-Snapshot`, so reload the search index and search again.
The response carries only the contact ID, which the public contact resource already exposes.

The website page `/contacts/row/{snapshot}/{row}` redirects with 303 to `/contacts/{id}` and keeps its `from` search path.
When the snapshot changed, the page returns 409 with a short explanation and a link back to the search, and it works without JavaScript.

## HTTP behavior

GET, HEAD, and OPTIONS are supported.
Other methods return 405.
Public CORS permits anonymous reads and exposes validators, snapshot identity, request IDs, continuation links, and retry information.
Catalog ETags identify the serialized catalog representation.
Immutable archive URLs carry ETags and support conditional reads.
Errors use RFC 9457 `application/problem+json` with `code`, `status`, and a generated `requestId`.
400 denotes invalid input, 404 a missing resource, 406 an unacceptable content coding, 409 an obsolete cursor or row snapshot, and 503 temporary unavailability.
A 503 response includes Retry-After.
Error bodies omit SQL, stack traces, credentials, and user queries.
