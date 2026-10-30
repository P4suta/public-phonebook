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

Source artifacts have SHA-256 identities, byte limits, timeouts, conditional requests, and per-origin request spacing.
A rate-limited origin stops receiving new requests during its cooldown.
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
