# Public data API

The API serves the same organizational directory as the website without requiring an account, an API key, or HTML scraping.
The production origin is `https://dial.page`.
Local Cloudflare development uses `http://127.0.0.1:8787`.
Open `/api/docs` for an interactive request form, response headers, and copyable request examples.
Open `/api/openapi.json` for the OpenAPI 3.1 description generated from the Rust request and response types.
`mise x -- cargo run --locked -p public-phonebook -- openapi` prints that description without requiring a database.
The contract is unreleased and uses unversioned paths.

## First request

```sh
phonebook_url=https://dial.page
curl --fail-with-body --get \
  --data-urlencode 'q=横浜市役所' \
  "$phonebook_url/api/contacts"
```

The response contains `data`, `meta`, pagination `links`, and complete-result `exports`.
`meta.total` counts organizational records, including distinct records that share a telephone number.
Contact resources include original and canonical telephone values, source identity and URL, license and terms URL, source date, retrieval time, attribution, and resource links.
Identifiers are opaque.
Follow the supplied links instead of interpreting identifiers or constructing path segments manually.
The root `/api` response discovers the collections, catalog, documentation, schema, and bulk downloads.

## Resources

| GET path | Result | Parameters |
| --- | --- | --- |
| `/api` | API discovery and full-directory downloads | `snapshot` |
| `/api/contacts` | Contact search | `q`, `prefecture`, `municipality`, `category`, `page`, `snapshot` |
| `/api/contacts/{id}` | One contact with provenance and links | `snapshot` |
| `/api/contacts/{id}/vcard` | One vCard 3.0 file | `snapshot` |
| `/api/sources` | Source reports ordered by identifier | `page`, `snapshot` |
| `/api/sources/{id}` | One source report, archive identities, and import accounting | `snapshot` |
| `/api/catalog` | Categories, prefectures, municipalities, and coverage counts | `snapshot` |
| `/api/export` | Every matching record as JSON, CSV, or vCard | `q`, `prefecture`, `municipality`, `category`, `format`, `snapshot` |

Parameters are optional.
Unknown names, repeated parameters, invalid values, contradictory regions, page zero, and pages beyond the last page return 400.
Use `q` for a normalized name fragment or a complete Japanese telephone number.
The search string admits at most 512 UTF-8 bytes.
Use a two-digit prefecture code from `01` through `47`, a five-digit municipality code, and a category identifier from the catalog.
Municipalities must belong to the selected prefecture when both are supplied.
Use an HTTP client's query encoder for Japanese text, plus signs, and other reserved characters.
The request target is limited to 8192 bytes after encoding.

## Pagination and consistent snapshots

Collections return 50 records per page.
Start on page 1 and follow `links.next` until it is `null`.
The response also supplies `self`, `first`, `previous`, and `last` links.
Links are origin-relative URI references.
Resolve them against the response URL, for example with `new URL(link, response.url)`.

JSON collection and resource envelopes identify the database with `meta.snapshot`.
Successful data responses also carry `X-Public-Phonebook-Snapshot`, including raw exports and vCards.
Generated links include this identity in their `snapshot` parameter.
An active database with a different identity returns 409 before selecting or exporting records.
Discard an incomplete collection and restart from `/api` when this happens.
The identity is the SHA-256 of the database, not a checksum of each serialized download.
Response fields may be added; consumers should ignore fields they do not recognize.

## Bulk reuse

Use the `exports.json` or `exports.csv` link returned by a search to retrieve all matches in one transfer.
The discovery response supplies the equivalent links for the entire directory.
Export requests have no page parameter and default to JSON.
JSON preserves original text values.
CSV applies the project's formula-prefix policy to text cells, while canonical telephone values retain their international representation.
The download remains a bounded stream and reports preparation failures before download headers.
Only consume a download after its HTTP transfer completes successfully.

```sh
curl --fail-with-body --get \
  --data-urlencode 'prefecture=14' \
  --data-urlencode 'category=medical' \
  --data-urlencode 'format=json' \
  "$phonebook_url/api/export" \
  --output contacts.json
```

The `license`, `license_url`, `source_url`, and applicable `attribution` fields carry the source-specific reuse information.
Bulk exports omit empty attribution text and retain the source and terms fields.
Retain and evaluate those terms when redistributing data.
The source and retrieval dates do not establish that a telephone number is currently assigned or operational.
Archive hashes identify imported source bytes; upstream publication URLs can later change.
The service distributes the derived directory and source metadata, while archived input files remain in the offline data workspace.

## Errors and browsers

Errors use [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457.html) with `application/problem+json`.
Use `code` for programmatic handling and `request_id` for diagnostics.
`invalid_parameters` identifies rejected inputs without echoing query values or internal errors.

| Status | Code | Action |
| --- | --- | --- |
| 400 | `invalid_query` | Correct the named input using the catalog and schema. |
| 404 | `not_found` | Discover or search for a resource in the current snapshot. |
| 405 | `method_not_allowed` | Use GET or HEAD. |
| 409 | `snapshot_changed` | Restart from discovery to use one snapshot. |
| 503 | `unavailable` | Wait for `Retry-After` before retrying. |

The API permits anonymous cross-origin reads and OPTIONS preflight requests.
Cookies and authorization headers are unnecessary.
Browser responses expose the request identity, snapshot, retry delay, download disposition, and schema validator headers.
The schema supports ETag revalidation.
Searches and exports share the service's bounded capacity rather than an unbounded request queue.
The JSON API does not depend on rendered cards or the internal `/internal/search` enhancement feed.
See [verification](verification.md) for current evidence and [deployment](deployment.md) for the local and publication boundaries.
