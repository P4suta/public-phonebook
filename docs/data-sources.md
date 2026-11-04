# Retained public data and provenance

The local TypeScript directory preserves the collected public snapshot and its source reports.
It contains 667,696 contact records and 561,495 distinct telephone numbers across 47 prefectures and 62 populated categories.
These are published contact points rather than unique legal entities.
Shared telephone numbers do not merge different facilities or departments.
Private address books and personal account synchronization are outside the data boundary.

## Source families

The retained registries in `sources/` record the publications, release inventories, dates, and reuse metadata used during collection.
They include the archived input and the current TypeScript collection manifests.
The preparation tool reads canonical native publications or the retained legacy archive without modifying either input.
The collector downloads explicitly licensed public directories, reconciles school identities, and creates a separately checked overlay.

| Categories | Retained publisher or publication |
| --- | --- |
| Medical, dental, pharmacy | Regional health bureaus' insurance-designated facility lists |
| Municipal offices | japan-municipal-offices, commit 6141f3d547848b5ecc333e0a9ba9e9fb80149aac |
| Prefectural offices | Cabinet Office administrative assistance guide, June 2026 |
| Nursing care | MHLW nursing care open data, 2026-06-30 |
| Disability support | WAM NET disability support open data, 2026-09-30 |
| Libraries, museums, archives | National Diet Library institution registers, 2026-10-05 |
| Nurseries and five related childcare categories | Children and Families Agency / WAM NET nationwide publication, collected 2026-10-29 |
| Universities, junior colleges, technical colleges | MEXT higher education lists |
| Elementary, junior high, high, compulsory, secondary, special-needs, vocational, and miscellaneous schools | Official prefectural and municipal directories reconciled with MEXT school codes |
| Police headquarters, police stations, police boxes, and residential police boxes | National Police Agency directory dated 2026-04-01 and licensed municipal directories |
| Community centers, sports facilities, cultural halls, health centers, and other public service offices | Publisher-specific open datasets indexed by BODIK ODM |
| Consumer consultation | National Consumer Affairs Center open data |
| Labour bureaus, inspection, consultation, and eight employment categories | MHLW regional and employment-service lists |
| Child guidance | Children and Families Agency national list |
| Social withdrawal support | MHLW local support directory |
| Pension offices and consultation centers | Japan Pension Service office directory |
| Tax offices | National Tax Agency office directory |
| Legal affairs bureaus | Ministry of Justice directory |
| Fire brigade administration | Fire and Disaster Management Agency directory |
| Police consultation | National Police Agency non-emergency consultation publication |

The [published-contact decision](adr/published-contact-points-and-coverage.md) records the retained identity and coverage rules.
The archived publication excludes the personal, operator, fax, and emergency-dispatch fields described in the retained registries.
Specialized categories need not have a location in every prefecture.
An empty category/prefecture cell is not evidence that no such service exists.

## Record-level evidence

Every contact retains its stable ID, source record ID, one or more source-page URLs, reuse label and URL, source date, retrieval date, and all published telephone values.
Absent websites are null.
Multiple source-page URLs remain a structured array rather than a comma-separated link.
Original telephone display values remain separate from canonical Japanese E.164 values.
Normalization checks representation and does not establish allocation, ownership, opening hours, or reachability.

`/api/sources` exposes retained file hashes, index and reuse-document hashes when supplied, archived artifact identities, and import counts.
Missing phone fields, invalid rows, and duplicate rows remain distinct accounting fields.
Absent index or policy hashes remain null rather than invented values.
The website opens a readable source page before an original publication file.
It preserves the search conditions when returning.

## Integrity and reuse

`npm run data:check -- .local/phonebook` reconciles the prepared database, canonical contact digest, source references, indexes, counts, and complete downloadable files.
The snapshot identifies the canonical contact records.
Each archive also has its own digest in its URL and manifest, so representation changes cannot reuse an immutable archive URL.
The local ready manifest includes the input database hash and prepared database hash.
The original collection database and raw source archives remain separate from runtime deployment artifacts.

Application licensing does not replace source-specific data terms.
The catalog identifies publishers and reuse links, and each contact preserves its own terms.
Custom publisher terms remain their published labels rather than being assigned a different standard license.
Source truth and freshness remain properties of the retained publications and require separate collection review before an update.

## Repeatable collection

`sources/public-facilities.json` selects 453 directory plans with observed minimum contact counts.
`sources/contact-directories.json` retains the manually reviewed prefectural school adapters.
Run `mise x -- just data-collect .local/collection/current` to retrieve and verify the selected sources.
Run `mise x -- just data-replay .local/collection/replayed` to reproduce contact and source output from the verified byte cache without network access.
Use `mise x -- just data-discover .local/collection/candidates.json` to discover additional licensed candidates for review.
Discovery does not add unreviewed files directly to a publication.

A collection writes `contacts.jsonl`, `sources.json`, `artifacts.json`, and `collection-report.json`.
`artifacts.json` lists every source artifact the run read, in URL order, with its digest and retrieval metadata.
The report lists plans, conflicts, failures, and coverage in a fixed order, whichever order the sources finished in.
It also records the digest and size of the other three files, so its own digest identifies the complete output.
`mise x -- node tools/collection-store.ts compare .local/collection/current .local/collection/replayed` requires a replay to match its collection byte for byte.

Source artifacts have SHA-256 identities, byte limits, timeouts, and conditional requests.
The collector keeps one request in flight per origin and waits five seconds between requests to it.
An origin that answers HTTP 403 or HTTP 429 receives no further request during the run, and each remaining source of that origin fails with a message that names the refusal.
`mise x -- node tools/collect.ts run sources/public-facilities.json --output .local/collection/current --reuse-cache` later keeps the retrieved files and requests only the missing ones.
Each accepted school has a unique compatible active MEXT code, a matching name, and either a matching postal code, address, or exact qualified identity.
Telephone numbers come from explicit voice fields; fax fields and incomplete local numbers without a published area code are excluded.
Conflicting numbers in the selected source-date cohort are excluded and reported.
Shared switchboards do not establish facility identity.
Publisher update timestamps do not become invented data-reference dates.

The current overlay adds 16,763 contacts, including 6,647 schools in 31 prefectures.
The active MEXT registry contains 38,516 schools in the admitted categories, so this collection is not complete school coverage.
The police source and other public directories extend the overlay across all 47 prefectures.
Seventy-nine conflicting candidate identities are excluded.
Missing telephone fields, unavailable sources, unmatched schools, inactive schools, and unsupported facility classes remain inspectable collection outcomes.

Prepare an extended native publication with `mise x -- just data-prepare BASE_DATABASE OUTPUT_DIRECTORY COLLECTION_DIRECTORY`.
An incomplete collection, unknown source reference, duplicate added ID, or attempted replacement of a published contact ID is refused.
Preparation normalizes addresses in the API and all three downloadable formats.
It removes recognized postal prefixes and map annotations, normalizes full-width ASCII and numeric separators, and converts bounded block numerals.
Named places such as 一番町 and 一条通, compatibility kanji, building names, and useful building annotations are preserved.
Only populated categories appear in the prepared catalog.

## Collection in GitHub Actions

The `Collect` workflow in `.github/workflows/collect.yml` repeats the collection on a hosted runner.
The owner starts it by hand on `main`, it has no schedule, and it stops on any other branch.

1. The `collect` job runs `just data-collect` and `just data-replay`, and it requires the replay to match the collection byte for byte.
   It holds no credentials, because it parses publisher files with the PDF, workbook, and HTML readers.
   It hands the collection and its source cache to the next job as an artifact that expires after one day.
2. The `store` job runs in the `data` environment and fetches the Doppler `ci_data` config through GitHub OIDC.
   It downloads the base database that `sources/base-dataset.json` pins and refuses one whose manifest, size, or digest differs from the pin.
3. It fetches the delta bases that the next section describes, and it fails before any write when it can't fetch or verify one.
4. It prepares the publication from that base, the collection, and the delta bases with `just data-prepare`.
   Then it runs `just data-check` and `just phone-quality` on the complete publication.
5. Only after those checks pass, it writes to the private `dial-control` bucket under write-once keys.
   It refuses a collection file that differs from the report and a source byte that differs from its digest.
   It also refuses a publication whose source database isn't the pinned base.
   The publication must hold as many contacts as the base and the collection together.

| Key | Contents |
| --- | --- |
| `collection-cache/DIGEST` | The bytes of each source artifact |
| `collections/REPORT/` | `collection-report.json`, `contacts.jsonl`, `sources.json`, `artifacts.json`, and `dataset.json` |
| `blobs/sha256/DIGEST` and `datasets/MANIFEST/` | The prepared database, archives, ready manifest, and catalog |

`REPORT` is the digest of `collection-report.json`, and `dataset.json` names the base manifest, the base database, and the prepared manifest.
The job writes the publication last, so a stored manifest means that every other object is present.
Storing the same collection again changes nothing.
`artifacts.json` and the cached bytes are enough to rebuild the source cache and replay the collection offline.
The store step prints the report digest and the manifest digest that a release names.

The base is the retained publication `d5d630…`, whose database `03a3424b…` holds 650,933 contacts.
The pin names its manifest digest, its database digest and size, and the database's `blobs/sha256/` key in `dial-control`.
Change the pin only together with a reviewed base in `dial-control`.

### Delta bases

`node tools/collection-store.ts delta-bases DIRECTORY` chooses the datasets that the new publication gets deltas from.
It takes every dataset in `sources/shipped-snapshots.json`, which lists each dataset that a TestFlight or App Store build bundles, by its ready manifest digest and snapshot, with the first app version that ships it.
It also takes the datasets of the 12 most recent verified production releases in the `dial-control` release records, counting each snapshot once.
The cap of 12 applies only to those published datasets.
A published dataset whose manifest lists no `directory.tsv.br` can't be a base, so the step logs it and skips it.
For each base it fetches the ready manifest and `directory.tsv.br` by dataset digest, and no database.
It requires each manifest to match its digest and snapshot, and each archive to match the manifest's size and digest.
It writes only local files, so a base that it can't fetch or verify fails the job before the store step writes anything.
Preparation keeps the rule that a delta's Brotli bytes stay at or below half of the complete archive, and it logs each base and the size of its delta.
The store step reports each shipped dataset that gets no delta as a warning, because that calls for a newer bundle in the next app release.
An entry leaves `sources/shipped-snapshots.json` in a reviewed change, at least 12 months after the App Store stopped offering a version that bundles it.

### Owner setup

1. Import the retained records with `just control-import` as the [deployment guide](deployment.md#control-store) describes, so that `dial-control` holds the pinned base.
2. Create an R2 API token that reads and writes only the `dial-control` bucket.
3. Fill `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in the Doppler `ci_data` config.
4. Create a Doppler service account with read access to that config only.
   Give it a GitHub OIDC identity for the subject `repo:P4suta@42543015/public-phonebook@1438449191:environment:data`.
5. Store the identity's ID as the `DOPPLER_IDENTITY_ID` variable of the GitHub `data` environment.
6. Start the workflow with `gh workflow run collect.yml --ref main`, or from the Actions page.

The first run also measures whether the publishers answer a runner outside Japan.
A failed collection keeps both reports as an artifact for seven days and writes nothing to `dial-control`.
If publishers refuse the hosted runners, keep collecting locally with `just data-collect`.
