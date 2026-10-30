# Retained public data and provenance

The local TypeScript directory preserves the collected public snapshot and its source reports.
It contains 650,933 contact records and 546,133 distinct telephone numbers across 47 prefectures and 39 categories.
These are published contact points rather than unique legal entities.
Shared telephone numbers do not merge different facilities or departments.
Private address books and personal account synchronization are outside the data boundary.

## Source families

The retained registries in `sources/` record the publications, release inventories, dates, and reuse metadata used during collection.
They document the archived input; the retired collection adapters are not part of the TypeScript runtime.
The current preparation tool reads the complete archived SQLite publication without changing it.
It does not claim to rediscover or refresh upstream websites.

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
