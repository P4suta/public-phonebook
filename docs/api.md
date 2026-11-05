# Open data files

The complete dataset files, their listings, and the delta files are open to every client.
They need no API key, cookie, account, or HTML scraping, and they carry cross-origin headers.
The data page at `/data` lists the current files with their format, size, SHA-256, and download link.
The site's search, contact, and search index routes serve only the site, as [the route split decision](adr/serve-directory-json-to-the-site-only.md) records.

## Find the current files

`GET /api/datasets` returns the one dataset listing.
It holds `snapshot`, `generatedAt`, the contact and telephone counts, the source and database digests, `files`, and `datasetDeltas`.
`datasetDeltas` links the delta listing of the same snapshot with `?snapshot=`.
Both listings accept an optional `?snapshot=` pin and name the current snapshot in `X-Dataset-Snapshot`.
A pinned listing returns 409 after a change, so a client can tell that its link went stale.
A duplicate or malformed `snapshot` returns 400.
Both listings revalidate with `Cache-Control: public, no-cache, must-revalidate` and a strong ETag, the SHA-256 of the response body.
A request whose `If-None-Match` matches that ETag under the weak comparison of RFC 9110 gets 304 with the ETag, `Cache-Control`, and `X-Dataset-Snapshot`, and no body.
The pin check runs first, so a stale pin returns 409 even when its validator matches.
`HEAD` returns the same headers without the body.
No route carries a version in its path.

```sh
curl --fail-with-body http://127.0.0.1:8787/api/datasets
```

### File formats

Each entry in `files` and each entry in the delta listing's `deltas` declares `format`.
A format is an identifier, a slash, and the version of the file's bytes as served, compression included.
Choose files by `format`, and skip entries in formats that your client doesn't read.

| File | Format | Content |
| --- | --- | --- |
| `contacts.jsonl.gz` | `public-phonebook-contacts-jsonl/1` | gzip JSON Lines, one contact per line |
| `contacts.csv.gz` | `public-phonebook-contacts-csv/1` | gzip CSV with the columns below |
| `contacts.vcf.gz` | `public-phonebook-contacts-vcard/1` | gzip vCard 3.0 cards |
| `directory.tsv.br` | `public-phonebook-directory/1` | The [native directory archive](#native-directory-archive) |
| `directory-delta-{base}.tsv.br` | `public-phonebook-directory-delta/1` | A [native directory delta](#native-directory-deltas) |

The native archive and delta identifiers equal the first decoded line with a slash in place of the tab.
A format change ships as a new entry with a new identifier beside the old one.
The listing keeps the old entry until its clients have moved, and an identifier never changes meaning.
[The dataset file formats decision](adr/declare-dataset-file-formats-instead-of-api-versions.md) records this rule.

## Download complete data

The dataset listing names complete gzip-compressed JSONL, CSV, and vCard files and a Brotli-compressed native directory archive with byte lengths and SHA-256 hashes.
Use each returned URL directly.
The URL includes both the contact snapshot and the archive digest, so a changed representation gets a different immutable URL.
Validate the downloaded byte length and SHA-256 before processing it.
Downloads contain the complete directory.
Every file URL answers a single `Range: bytes=` range with 206, `Content-Range`, and `Accept-Ranges: bytes`, so an interrupted download can resume.
A first-byte position at or past the end, or a zero-length suffix, returns 416 with `Content-Range: bytes */SIZE`.
A malformed or multiple range, or an `If-Range` that doesn't match the ETag, returns the whole file with 200.
Check the SHA-256 over all the bytes once the resumed file is complete.
Source-specific reuse terms remain attached to every record.
CSV records carry the columns `id`, `name`, `category`, `prefecture_code`, `municipality_code`, `address`, `phone_numbers`, `website`, `source_id`, `source_url`, `license`, `license_url`, and `data_as_of`.
A `phone_numbers` cell holds the contact's E.164 numbers unescaped and separated by semicolons, the same values as `e164` in JSON Lines and `TEL` in vCard.
Validation admits only `+81` and digits in each number, so the cell can't call a function, reference a cell, or run a command.
A spreadsheet may still read that cell as a number, so import the column as text to keep the plus sign.
Every other cell that begins with `=`, `+`, `-`, `@`, a tab, a carriage return, or a full-width `＝`, `＋`, `－`, or `＠` receives a leading apostrophe.
That guard covers the characters of the formula-escaping option in the pinned `csv-stringify` serializer, which writes quoted fields and CRLF records.
JSONL retains the canonical structured values.
Each phone retains the publisher's spelling in `display` and its canonical dial destination in `e164`.
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
`GET /api/dataset-deltas` lists the deltas to the current snapshot, and the dataset listing links it as `datasetDeltas` with the snapshot pin.
The response holds the current `snapshot`, the `archiveSha256` of the `directory.tsv.br` that every delta rebuilds, and a `deltas` array that may be empty.
Each entry names its `base` snapshot, the `baseArchiveSha256` of that snapshot's `directory.tsv.br`, its `file`, `format`, and `url`, and the `bytes` and `sha256` of its Brotli bytes.
It also gives the `uncompressedBytes` and `uncompressedSha256` of the decoded delta, so a client can bound its decoder.
The listing revalidates with its own strong ETag, like the dataset listing.
The URL serves the exact Brotli bytes as `application/octet-stream` without `Content-Encoding`, with the immutable caching of the complete files.
The file is `directory-delta-` followed by the base snapshot and `.tsv.br`.
Preparation publishes a delta only when its Brotli bytes are at most half of the complete archive's.
It starts deltas from every snapshot that a supported app version bundles and from the 12 most recently published snapshots, so the listing holds at most 24 of them.

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

## The site's own routes

Search, category previews, contacts, single vCards, sources, the catalog, the search index, and the row locator answer only under `/api`.
They send no cross-origin headers, and they answer `OPTIONS` with 405.
A request whose `Sec-Fetch-Site` header is present and differs from `same-origin` gets a 403 problem with the code `cross_origin`.
A request without that header stays admitted, so server rendering and the release checks reach these routes.
Search accepts page sizes from 1 through 30.
The website uses `/api/contacts` for its initial server results and ranked continuation.
The response keeps its existing `data`, snapshot, total, cursor, and link fields.
The category-preview endpoint keeps its existing response for other site consumers.
After the website admits both search artifacts, its device scorer supplies up to 100 forgiving name candidates in a separate rank order.
The server keeps its literal matching and ordering contract, including for pages without JavaScript.

### Website search index

`/api/datasets` doesn't list the search index, and no open-data route serves it.
`GET /api/search-index` returns the current `snapshot`, the immutable index `url`, and the `bytes` and `sha256` of the Brotli bytes.
It also returns the `uncompressedBytes` and `uncompressedSha256` of the decoded index.
The response revalidates with an ETag, like the catalog.

`GET /api/search-index/{snapshot}/{sha256}` returns the stored Brotli bytes with `Content-Encoding: br`, so the HTTP client decodes them.
The decoded bytes are `search-index.br` format 1, which [the search index decision](adr/publish-a-name-ordered-search-index-for-the-website.md) describes.
Its header also lists, in `rowsWithoutAddress`, the ascending 0-based positions of rows whose details show no address.
A header without that list marks every row as having an address.
Only the current snapshot and the current digest exist, and any other pair returns 404.
A request returns 406 unless its `Accept-Encoding` names `br`, or `*`, with a nonzero weight.
Cloudflare rewrites `Accept-Encoding` before the Worker runs, so the Worker first reads the visitor's own value from `cf.clientAcceptEncoding`.
When neither value reaches the Worker, it also returns 406, because the index has no unencoded representation.
The response carries the digest as a strong ETag, answers a matching `If-None-Match` with 304, and is cached for a year as immutable.
Its `Content-Type` is `application/octet-stream`, because the decoded index mixes UTF-8 lines with binary category and region parts.
Check the decoded length, the decoded SHA-256, the format line, and the header snapshot before using the index.

### Device ranking artifact

`GET /api/search-ranking` discovers the optional `public-phonebook-search-ranking/1` artifact.
Its response declares `format`, `snapshot`, the immutable `url`, and compressed and decoded byte sizes and SHA-256 digests.
`GET /api/search-ranking/{snapshot}/{sha256}` follows the search index's Brotli, validator, same-origin, and current-snapshot rules.
A snapshot without the companion returns 503 from discovery.
The artifact supplements `search-index.br` and uses the same 0-based row positions.
Consumers must verify both decoded digests and admit only a matching snapshot and contact count.
The [artifact decision](adr/publish-snapshot-bound-forgiving-search-artifacts.md) defines its byte format and generator.

### Locate a contact by index row

`GET /api/contacts/row/{snapshot}/{row}` returns `{ "id": "…" }` for a 0-based row of that snapshot's search index.
The row is a decimal number without a sign or leading zeros.
D1 numbers contacts in index order, so row `n` is the contact whose D1 rowid is `n + 1`.
A malformed snapshot or row returns 400, a snapshot that isn't current returns 409, and a row at or past the contact count returns 404.
A 409 response names the current snapshot in `X-Dataset-Snapshot`, so reload the search index and search again.

The website page `/contacts/row/{snapshot}/{row}` redirects with 303 to `/contacts/{id}` and keeps its `from` search path.
When the snapshot changed, the page returns 409 with a short explanation and a link back to the search, and it works without JavaScript.

## HTTP behavior

GET and HEAD work on every route, and the open-data routes also answer `OPTIONS` preflight requests.
Other methods return 405 with an `Allow` header.
The open-data cross-origin headers expose validators, snapshot identity, request IDs, and retry information.
Immutable archive URLs carry ETags and support conditional reads.
Errors use RFC 9457 `application/problem+json` with `code`, `status`, and a generated `requestId`.
400 denotes invalid input, 403 a site route requested from another site, 404 a missing resource, 406 an unacceptable content coding, 409 an obsolete pin, cursor, or row snapshot, and 503 temporary unavailability.
A 503 response includes Retry-After.
Error bodies omit SQL, stack traces, credentials, and user queries.
