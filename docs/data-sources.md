# Retained public data and provenance

The local TypeScript directory preserves the collected public snapshot and its source reports.
It contains 672,133 contact records and 565,766 distinct telephone numbers across 47 prefectures and 65 populated categories.
The counts measure published contact points.
Shared telephone numbers don't merge different facilities or departments.
Private address books and personal account synchronization are outside the data boundary.

## Source families

The retained registries in `sources/` record the publications, release inventories, dates, and reuse metadata used during collection.
They include the archived input and the current TypeScript collection manifests.
The preparation tool reads canonical native publications or the retained legacy archive without modifying either input.
The collector downloads explicitly licensed public directories, reconciles school identities, and creates an overlay that the data gate checks.

Regional health bureaus' insurance-designated facility lists supply medical, dental, and pharmacy contacts.
Municipal office contacts come from `japan-municipal-offices` at commit `6141f3d547848b5ecc333e0a9ba9e9fb80149aac`.
Prefectural office contacts come from the Cabinet Office's June 2026 administrative guide.

Nursing care contacts come from the Japanese health ministry's open data dated June 30, 2026.
Disability support contacts come from `WAM NET` open data dated September 30, 2026.
The National Diet Library's institution registers dated October 5, 2026 supply libraries, museums, and archives.
The Children and Families Agency and `WAM NET` nationwide publication supplies nurseries and five related childcare categories.
The archived nursery collection dates from October 29, 2026.

The education ministry's higher education lists supply universities, junior colleges, and technical colleges.
Official prefectural and municipal directories supply elementary, junior high, high, compulsory, secondary, special-needs, vocational, and miscellaneous schools.
The collector reconciles school identities with the ministry's school codes.
The National Police Agency directory dated April 1, 2026 and licensed municipal directories supply police headquarters, stations, police boxes, and residential police boxes.
Publisher-specific open datasets indexed by `BODIK ODM` supply community centers, sports facilities, cultural halls, health centers, and other public service offices.

National Consumer Affairs Center open data supplies consumer consultation offices.
The health ministry's regional and employment-service lists supply employment bureaus, inspection and consultation offices, and eight employment categories.
The Children and Families Agency national list supplies child guidance offices.
The health ministry's local support directory supplies social withdrawal support offices.
Japan Pension Service supplies pension offices and consultation centers.
National Tax Agency, Ministry of Justice, Fire and Disaster Management Agency, and National Police Agency directories supply tax offices, legal affairs bureaus, fire brigade administration, and police consultation contacts.

The expanded overlay includes municipal contacts for school expense support from [the Ministry of Education, Culture, Sports, Science and Technology's October 2026 directory](https://www.mext.go.jp/a_menu/shotou/career/05010502/1414943_00003.htm).
Municipality names qualify department names when the publication supplies both fields.
The [national customs index](https://www.customs.go.jp/kyotsu/map/index.htm), [immigration office index](https://www.moj.go.jp/isa/about/region/), and [legal affairs bureau index](https://houmukyoku.moj.go.jp/homu/static/kankatsu_index.html) supply regional and branch contacts.
Agency names qualify branches whose published names would otherwise be ambiguous.

The [Cabinet Office directory](https://www.gender.go.jp/policy/no_violence/e-vaw/soudankikan/01.html) supplies domestic violence support contacts dated October 20, 2026.
The Japanese health ministry lists mental health consultation offices in its [directory of direct telephone lines](https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/hukushi_kaigo/seikatsuhogo/jisatsu/kokoro_dial_ip.html).
Only rows identifying a center or consultation office enter the mental health center category.
The broader list of operating organizations doesn't establish a center's identity.

Hokkaido's published directories add public high schools, private schools, health centers, and passport offices.
The [Hokkaido reuse policy](https://www.dokyoi.pref.hokkaido.lg.jp/site-info/sitepolicy.html) states that the prefecture's pages are open data under `CC BY` unless marked otherwise.
The collector imports the published contact fields under their recorded terms.
Tokyo's October 2025 social welfare directory adds health centers, child and family support offices, and sports centers for people with disabilities under its recorded `CC BY 4.0` terms.
The [Tokyo Fire Department directory](https://spec.api.metro.tokyo.lg.jp/spec/t000017d0000000001-3fee06f821a01a61cc449bab77f89346-0) retains its April 2023 reference month.
Its numeric CSV omits the national trunk zero, so its reviewed adapter declares the prefix explicitly.
An unconfigured source never receives that repair.

The [published-contact decision](adr/published-contact-points-and-coverage.md) records the retained identity and coverage rules.
The archived publication excludes the personal, operator, fax, and emergency-dispatch fields described in the retained registries.
Specialized categories need not have a location in every prefecture.
An empty category/prefecture cell isn't evidence that no such service exists.

## Record-level evidence

Every contact retains its stable ID, source record ID, one or more source-page URLs, reuse label and URL, source date, retrieval date, and all published telephone values.
Absent websites are null.
Source-page URLs remain a structured array.
Each contact keeps display and canonical Japanese E.164 telephone values.
The collector formats admitted numbers for display.
Retained source artifacts preserve the publisher's original cell contents.
Normalization checks representation and doesn't establish allocation, ownership, opening hours, or reachability.

`/api/sources` exposes retained file hashes, index and reuse-document hashes when supplied, archived artifact identities, and import counts.
Missing phone fields, invalid rows, and duplicate rows remain distinct accounting fields.
Absent index or policy hashes remain null rather than invented values.
The website opens a readable source page before an original publication file.
It preserves the search conditions when returning.

## Integrity and reuse

`npm run data:check -- .local/phonebook` reconciles the prepared database, canonical contact digest, source references, indexes, counts, and complete downloadable files.
The snapshot identifies the canonical contact records.
Each archive also has its own digest in its URL and manifest, so representation changes can't reuse an immutable archive URL.
The local ready manifest includes the input database hash and prepared database hash.
The original collection database and raw source archives remain separate from runtime deployment artifacts.

The software license doesn't replace source-specific data terms.
The catalog identifies publishers and reuse links, and each contact preserves its own terms.
The catalog preserves each publisher's custom reuse label.
Source truth and freshness remain properties of the retained publications and require separate collection review before an update.

## Repeatable collection

`sources/public-facilities.json` selects 598 directory plans with observed contact floors.
`sources/contact-directories.json` retains the manually reviewed prefectural school adapters.
Run `mise x -- just data-collect .local/collection/current` to retrieve and verify the selected sources.
Run `mise x -- just data-replay .local/collection/replayed` to reproduce contact and source output from the verified byte cache without network access.
Use `mise x -- just data-discover .local/collection/candidates.json` to discover licensed candidates for review.
Discovery doesn't add unreviewed files directly to a publication.

A collection writes `contacts.jsonl`, `sources.json`, `artifacts.json`, and `collection-report.json`.
`artifacts.json` lists every source artifact the run read in URL order.
Each entry records its digest and retrieval metadata.
The report lists plans, conflicts, failures, and coverage in a fixed order, whichever order the sources finished in.
It also records the digest and size of the other three files, so its own digest identifies the complete output.
`mise x -- node tools/collection-store.ts compare .local/collection/current .local/collection/replayed` requires a replay to match its collection byte for byte.

Source artifacts have SHA-256 identities, byte limits, timeouts, and conditional requests.
The collector keeps one request in flight per origin and waits five seconds between requests to it.
An origin that answers HTTP 403 or HTTP 429 receives no further request during the run.
Each remaining source of that origin fails with a message that names the refusal.
`mise x -- node tools/collect.ts run sources/public-facilities.json --output .local/collection/current --reuse-cache` later keeps the retrieved files and requests only the missing ones.
Each accepted school has a unique compatible active school code, a matching name, and either a matching postal code, address, or exact qualified identity.
Telephone numbers come from explicit voice fields.
The collector excludes fax fields and incomplete local numbers without a published area code.
The collector replaces line and tab separators in agency names with spaces before export.
Complete published telephone numbers remain separate from numeric parenthetical notes.
PDF record grouping follows the reviewed marker column in the publication's text order.
The adapters omit PDF website cells whose association with a row lacks verification.
Website cells containing whitespace don't enter the singular website field.
The collector excludes and reports conflicting numbers in the selected source-date cohort.
Candidate selection excludes every plan with a failed resource, including plans that emitted contacts before failing.
Selection never reduces an existing reviewed contact floor.
Shared switchboards don't establish facility identity.
Publisher update timestamps don't become invented data-reference dates.

The expansion reviews candidate headers, source dates, conflicting identities, and retention of earlier contact IDs before preparing a publication.
Candidate review excludes superseded Tokyo welfare directories, older Kawagoe resource versions, and Gifu's 2020 resources from the added plans.
The retained Gifu directories cover the prefecture in 2022.
Fujimino's defibrillator directories list the city's switchboard for a school and conflict with the public-facility directory.
The expansion excludes both resources without editing the conflicting numbers.
Unavailable resources and publications without admitted reuse terms don't enter the selected manifest.
The current education ministry PDF prints `077-5511-0130` for the `栗東市 教育部学校教育課` contact, while the [municipality's current department directory](https://www.city.ritto.lg.jp/soshiki/1677.html) prints `077-551-0130`.
The adapter excludes the conflicting row without guessing a digit repair or importing the municipality's page under another publisher's reuse terms.

The current overlay adds 21,200 contacts, including 7,145 schools in 33 prefectures.
The education ministry's active registry contains 38,516 schools in the admitted categories, so the collection isn't complete school coverage.
The police source and other public directories extend the overlay across all 47 prefectures.
The report excludes 80 conflicting candidate identities.
Missing telephone fields, unavailable sources, unmatched schools, inactive schools, and unsupported facility classes remain inspectable collection outcomes.

The education ministry's directory contributes 1,760 school expense support contacts, rather than every department of every education board.
The Cabinet Office's 327-center directory contributes 326 contacts because one center's row omits a telephone number.
The national fire directory adapter selects its 51 regional representative headquarters.
Tokyo's fire directory contributes 309 headquarters, stations, and other listed facilities.
The fire and passport categories still lack complete national coverage.
Court coverage remains limited to the admitted municipal datasets.
A complete collection means that the selected plans finished without failure.
It doesn't certify an exhaustive list of public institutions.

Prepare an extended native publication with `mise x -- just data-prepare BASE_DATABASE OUTPUT_DIRECTORY COLLECTION_DIRECTORY`.
Preparation refuses an incomplete collection, unknown source reference, duplicate added ID, or attempted replacement of a published contact ID.
Preparation normalizes addresses in the API and all three downloadable formats.
It removes recognized postal prefixes and map annotations, normalizes full-width ASCII and numeric separators, and converts bounded block numerals.
Address normalization preserves named places such as `一番町` and `一条通`, compatibility kanji, building names, and useful building annotations.
Only populated categories appear in the prepared catalog.

## Collection in `GitHub Actions`

The `Collect` workflow in `.github/workflows/collect.yml` repeats the collection on a hosted runner.
The owner starts it by hand on `main`, it has no schedule, and it stops on any other branch.

The `collect` job runs `just data-collect` and `just data-replay`, and it requires the replay to match the collection byte for byte.
It holds no credentials because it parses publisher files with the PDF, workbook, and HTML readers.
It hands the collection and its source cache to the next job as an artifact that expires after one day.

The `store` job runs in the `data` environment and fetches the Doppler `ci_data` config through GitHub OIDC.
It downloads the base database that `sources/base-dataset.json` pins and refuses one whose manifest, size, or digest differs from the pin.
It fetches the delta bases that the next section describes, and it fails before any write when it can't fetch or verify one.
It prepares the publication from that base, the collection, and the delta bases with `just data-prepare`.
Then it runs `just data-check` and `just phone-quality` on the complete publication.

After passing the checks, the job writes to the private `dial-control` bucket under write-once keys.
It refuses a collection file that differs from the report and a source byte that differs from its digest.
It also refuses a publication whose source database isn't the pinned base.
The publication must hold as many contacts as the base and the collection together.

The `collection-cache/DIGEST` key stores the bytes of each source artifact.
The `collections/REPORT/` prefix holds `collection-report.json`, `contacts.jsonl`, `sources.json`, `artifacts.json`, and `dataset.json`.
The `blobs/sha256/DIGEST` and `datasets/MANIFEST/` prefixes hold the prepared database, archives, ready manifest, and catalog.

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
It takes every dataset in `sources/shipped-snapshots.json`.
The file lists each dataset that a TestFlight or App Store build bundles by its ready manifest digest and snapshot.
Each entry names the first app version that ships the dataset.
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

Import the retained records with `just control-import` as the [deployment guide](deployment.md#control-store) describes, so that `dial-control` holds the pinned base.
Create an R2 API token that reads and writes only the `dial-control` bucket.
Fill `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in the Doppler `ci_data` config.

Create a Doppler service account with read access to that config only.
Give it a GitHub OIDC identity for the subject `repo:P4suta@42543015/public-phonebook@1438449191:environment:data`.
Store the identity's ID as the `DOPPLER_IDENTITY_ID` variable of the GitHub `data` environment.
Start the workflow with `gh workflow run collect.yml --ref main`, or from the Actions page.

The first run also measures whether the publishers answer a runner outside Japan.
A failed collection keeps both reports as an artifact for seven days and writes nothing to `dial-control`.
If publishers refuse the hosted runners, keep collecting locally with `just data-collect`.
