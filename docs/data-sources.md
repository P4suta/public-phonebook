# Data sources and reuse

Public Phonebook adapts public-source data into a searchable directory.
It is independently produced and is not an official government directory.
The source licenses apply to the imported data separately from the application license.
Names and addresses remain in their published Japanese form.
Opener and manager columns are excluded.

## Browsing source information

Each search result links to a readable source-details page before opening any original data file.
The page identifies the contact, publisher, source date, retrieval date, and reuse terms.
It links to the official website when supplied and to the publisher's listing page when available.
Original files appear separately with their format in the link label, such as ZIP, XLSX, or PDF.
Returning to the results preserves the search filters and page.
Exports retain the original upstream source URLs for provenance.

## Medical facilities, dental facilities, and pharmacies

The importer reads the complete published insurance-designated facility lists linked from these regional health bureau pages.
These lists include existing and suspended facilities, and are not a real-time service availability feed.
The medical information network's national CSVs are not used because the inspected national CSV schema lacks telephone numbers.

| Publisher | Prefecture codes | Source index | Reuse terms |
| --- | --- | --- | --- |
| Hokkaido | 01 | [Facility lists](https://kouseikyoku.mhlw.go.jp/hokkaido/gyomu/gyomu/hoken_kikan/zentai_ichiran.html) | [PDL 1.0 terms](https://kouseikyoku.mhlw.go.jp/hokkaido/aboutus/copyright.html) |
| Tohoku | 02–07 | [Facility lists](https://kouseikyoku.mhlw.go.jp/tohoku/gyomu/gyomu/hoken_kikan/itiran.html) | [PDL 1.0 terms](https://kouseikyoku.mhlw.go.jp/tohoku/aboutus/copyright.html) |
| Kanto-Shinetsu | 08–15, 19–20 | [Facility lists](https://kouseikyoku.mhlw.go.jp/kantoshinetsu/chousa/shitei.html) | [PDL 1.0 terms](https://kouseikyoku.mhlw.go.jp/kantoshinetsu/aboutus/copyright.html) |
| Tokai-Hokuriku | 16–17, 21–24 | [Facility lists](https://kouseikyoku.mhlw.go.jp/tokaihokuriku/newpage_00287.html) | [PDL 1.0 terms](https://kouseikyoku.mhlw.go.jp/tokaihokuriku/aboutus/copyright.html) |
| Kinki | 18, 25–30 | [Facility lists](https://kouseikyoku.mhlw.go.jp/kinki/tyousa/shinkishitei.html) | [PDL 1.0 terms](https://kouseikyoku.mhlw.go.jp/kinki/aboutus/copyright.html) |
| Chugoku | 31–35 | [Facility lists](https://kouseikyoku.mhlw.go.jp/chugokushikoku/chousaka/iryoukikanshitei.html) | [PDL 1.0 terms](https://kouseikyoku.mhlw.go.jp/chugokushikoku/aboutus/copyright.html) |
| Shikoku | 36–39 | [Facility lists](https://kouseikyoku.mhlw.go.jp/shikoku/gyomu/gyomu/hoken_kikan/shitei/) | [PDL 1.0 terms](https://kouseikyoku.mhlw.go.jp/shikoku/aboutus/copyright.html) |
| Kyushu | 40–47 | [Facility lists](https://kouseikyoku.mhlw.go.jp/kyushu/gyomu/gyomu/hoken_kikan/index_00006.html) | [PDL 1.0 terms](https://kouseikyoku.mhlw.go.jp/kyushu/aboutus/copyright.html) |

Attribution includes the publisher's source URL, source date, retrieval date, and an adaptation notice.
The importer retains the index page, reuse terms, and original Excel or ZIP bytes.
The checked index and policy hashes are included in each source report.
Unexpected source inventories or unrecognized table structures fail the update.

## Municipal offices

The municipal catalog and 47 prefecture CSV files come from [japan-municipal-offices at commit 6141f3d547848b5ecc333e0a9ba9e9fb80149aac](https://github.com/ytsubo8426/japan-municipal-offices/tree/6141f3d547848b5ecc333e0a9ba9e9fb80149aac).
The repository publishes the data under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
Each contact retains its upstream source URL and upstream `verified_at` value.
That upstream date is not a verification performed by this application.
Records without usable telephone numbers remain in import accounting and do not appear as callable contacts.

## Prefectural offices

The 47 representative numbers and addresses in `sources/prefectures.csv` were transcribed from page 59 of the Cabinet Office's [June 2026 administrative assistance guide](https://www.bousai.go.jp/taisaku/hisaisyagyousei/pdf/kakusyuseido_tsuujou.pdf).
The Cabinet Office publishes [PDL 1.0 reuse terms](https://www.cao.go.jp/notice/rule.html).
Official homepage URLs are discovered through [localgovjp's prefecture catalog](https://code4fukui.github.io/localgovjp/prefjp.json).
The importer records whether the published number was also found in an official homepage or contact page, including telephone links.
`official_phone_source` identifies a successful confirmation page, and its archived artifact is retained in the prefectural source report.
An unconfirmed homepage match does not silently become a verified match.

## Nursing care services

The [Ministry of Health, Labour and Welfare's nursing care open data](https://www.mhlw.go.jp/stf/kaigo-kouhyou_opendata.html) supplies 35 service-specific CSV files for the 2026-06-30 snapshot.
The publisher identifies the data as an extract of the Nursing Care Service Information Publication System and links to [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
The importer keeps office names, addresses, office telephone numbers, and published website URLs.
The importer excludes corporate operator and fax fields.
Exports include the publisher, system name, and adaptation notice in their attribution metadata.

## Disability support services

[WAM NET's disability support open data](https://www.wam.go.jp/content/wamnet/pcpub/top/sfkopendata/) supplies 30 service-specific ZIP files for the 2026-09-30 snapshot.
These cover adult services, services for children, and consultation services.
The source page describes reuse for commercial and noncommercial purposes under its published open-data terms.
The directory records those publisher terms without assigning a different standard license to them.
The importer reads the office telephone column and excludes the corporate telephone and fax columns.

## Libraries, museums, and archives

The [National Diet Library's institution registers](https://www.ndl.go.jp/library/isil) supply four CSV files dated 2026-10-05.
Two files cover public and other libraries, and the other two cover museums and archives.
The publisher places these register data in the public domain.
Institution identifiers, Japanese names, published addresses, representative telephone numbers, and website URLs are imported.
The deleted-institution register is excluded.
The register identifies participating institutions and doesn't establish that every institution is represented.

## Childcare and early education

The [Children and Families Agency / WAM NET childcare directory](https://www.wam.go.jp/kokodesearch/ANN010100E00.do) publishes nationwide CSV archives under [PDL 1.0](https://www.wam.go.jp/content/wamnet/pcpub/jidou/kdmsyspub/public/kd003.html).
The [childcare registry](../sources/childcare.toml) pins the release, source date, and exact archive inventory.
The current archive contains 376 Shift-JIS CSV files generated on 2026-10-29 from the preceding day's data.
It supplies nurseries, kindergartens, certified child centers, small-scale childcare, workplace childcare, and organizational unlicensed childcare facilities.
Only normally operating facilities enter the directory.
Closed, stopped, suspended, home-visit, family-home, individually operated unlicensed, and unspecified unlicensed operators are excluded and counted.
Only each facility's telephone is imported; operator telephone numbers, manager names, and individual carer records are excluded.
The public bulk download uses the publisher's ordinary form session and POST requests.
Session cookies remain in memory and are not written to the source archive.
The raw form pages and downloaded bytes are archived as publisher responses.
Use the publisher listing page to obtain the nationwide archive.

## Public services and higher education

The [civic registry](../sources/civic.toml) declares the source layouts, publisher URLs, reuse statements, dates, and exact download inventories.
The importer archives each publisher page, reuse statement, and data file.
HTML publication dates remain unspecified when the source supplies no date for the imported list.
The MEXT lists retain their published academic-year label.
Source freshness, operating hours, eligibility, and telephone reachability require checking the publisher.

| Categories | Official source | Reuse terms |
| --- | --- | --- |
| University, junior college, technical college | [MEXT higher education lists](https://www.mext.go.jp/a_menu/koutou/ichiran/mext_01853.html) | [MEXT website terms](https://www.mext.go.jp/b_menu/1351168.htm) |
| Consumer affairs consultation | [NCAC open data](https://www.kokusen.go.jp/map/index.html) | [NCAC open-data terms](https://www.kokusen.go.jp/info/data/opendata_policy.html) |
| Labour bureau, labour standards inspection, Hello Work | [MHLW regional offices](https://www.mhlw.go.jp/kouseiroudoushou/shozaiannai/roudoukyoku/index.html) | [PDL 1.0](https://www.mhlw.go.jp/chosakuken/index.html) |
| Labour consultation | [MHLW consultation corners](https://www.mhlw.go.jp/general/seido/chihou/kaiketu/soudan.html) | [PDL 1.0](https://www.mhlw.go.jp/chosakuken/index.html) |
| Child guidance centers and branches | [CFA national directory](https://www.cfa.go.jp/policies/jidougyakutai/jisou-ichiran/) | [PDL 1.0](https://www.cfa.go.jp/copyright-policy/) |
| Social withdrawal support | [MHLW local support directory](https://hikikomori-voice-station.mhlw.go.jp/support/) | [PDL 1.0](https://www.mhlw.go.jp/chosakuken/index.html) |
| Employment support for parents, graduates, young people, foreign residents, local communities, agriculture, and relocation | [MHLW employment services](https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/koyou/index.html) and category-specific pages in the registry | [PDL 1.0](https://www.mhlw.go.jp/chosakuken/index.html) |
| Pension offices and consultation centers | [Japan Pension Service office directory](https://www.nenkin.go.jp/section/soudan/index.html) | [Publisher reuse terms](https://www.nenkin.go.jp/info/aboutweb/aboutsite.html) |
| Tax offices | [NTA office directory](https://www.nta.go.jp/about/organization/access/map.htm) | [PDL 1.0](https://www.nta.go.jp/chuijiko/copy.htm) |
| Legal affairs bureaus | [Ministry of Justice directory](https://www.moj.go.jp/MINJI/minji10.html) | [PDL 1.0](https://www.moj.go.jp/hisho06_00280.html) |
| Volunteer fire brigade administration | [FDMA directory](https://www.fdma.go.jp/relocation/syobodan/welcome/search/) | [PDL 1.0](https://www.fdma.go.jp/about/others/post3.html) |
| Police consultation | [NPA consultation PDF](https://www.npa.go.jp/bureau/soumu/soudan/soudanmadoguti.pdf) | [PDL 1.0](https://www.npa.go.jp/rules/index.html) |

The school importer reads institution-level basic information and excludes personnel and department contact fields.
School identifiers follow MEXT's [published school-code families](https://www.mext.go.jp/b_menu/toukei/mext_01087.html): F1 for universities, F2 for junior colleges, and G1 for technical colleges.
The consumer CSV represents telephone numbers numerically and omits leading zeroes.
Only that adapter restores a domestic trunk prefix, with an explicit issue count and source-page explanation.
Other source adapters never invent missing telephone digits.
The labour lists contain both institutions and named department contact points, which remain distinct.
Pension records use the primary office address on each page and exclude general national helplines and fax fields.
Consultation-center telephone numbers are office staff contacts, and their source pages state that pension consultations are not provided by telephone.
Separate consultation-room addresses on the same page are omitted and recorded in source issues.
Tax office locations exclude subsequent mail-processing instructions.
Fire brigade records describe administrative contacts and may supply only a municipality as their location.
Police consultation records describe non-emergency numbers and supply only their prefecture as location.
The 51 police numbers were visually transcribed from the linked one-page PDF into [the seed CSV](../sources/police-consultation.csv).
The importer requires the exact PDF hash declared in the civic registry before accepting that transcription.
No emergency-dispatch category or dispatch number is inferred from these administrative directories.

## Contact identity and geographic coverage

The [public-data registry](../sources/public-data.toml) declares each publisher, snapshot date, release, reuse terms, and exact file inventory.
Files are selected from the publisher's page for that declared release.
Unknown inventories, duplicate required columns, missing columns, malformed CSV records, and ambiguous CSV archives fail the update.
CSV archive members are read in memory with a 128 MiB bound.

The importer collapses identical care or disability contact points across service lists using normalized names, addresses, and canonical telephone sets.
The primary source record and its file URL remain attached to the contact, and repeated rows remain in source accounting.
Different names, addresses, or telephone sets remain separate entries.
Cross-category records and institutions that share only a telephone number remain separate.
These counts describe published contact records rather than unique legal entities.
The [identity and coverage decision](adr/published-contact-points-and-coverage.md) explains the identifier tradeoffs.

The importer checks five- and six-digit local government codes, including the sixth digit's checksum when present.
The digit and checksum rules follow the [published local government code specification](https://www.j-lis.go.jp/data/open/cnt/3/1090/1/specifications20080401.pdf).
Code validation checks structure rather than whether every code is currently assigned.
Published prefectures and address prefixes must agree with the code.
The telephone extractor and normalizer share one character classifier, including compatibility hyphens and Unicode whitespace.
Missing digits and malformed numbers remain excluded and counted.

The directory declares 39 categories and reports all 1,833 prefecture/category cells.
Medical, dental, pharmacy, municipal office, prefectural office, nursing care, disability support, and library coverage must each be nonempty in all 47 prefectures.
Other category cells may be empty where the published lists provide no callable contact.
Specialized employment services and some educational institution types do not have a published location in every prefecture.
Zero cells remain explicit in coverage metadata and the data audit.

## Storage and updates

`data/raw/objects/<sha256>.bin` preserves immutable source bytes.
The adjacent URL-keyed cache metadata records the request URL, hash, and retrieval time.
`data/phonebook.sqlite` contains the active snapshot and its coverage metadata.
`/coverage.json` exposes counts for all 1,833 prefecture/category combinations and individual source reports.
`data/latest-import-report.json` records the latest completed or failed attempt.

Missing telephone fields, invalid rows, and exact duplicate identities have separate counts.
Multiple institutions may share a telephone number and remain separate contacts.
Original telephone formatting is retained alongside a normalized Japanese E.164 representation.
Normalization checks syntax and country representation, not allocation, ownership, or reachability.

Run `mise x -- just update-data` to reuse checked cached downloads and discover current index links.
Run `mise x -- just update-data --refresh` to retrieve every source again.
Update `sources/public-data.toml`, `sources/childcare.toml`, or `sources/civic.toml` to adopt a different declared release or inventory.
Stop the server before either command.
Run `mise x -- just validate-data` to reconcile active data, indexes, counts, and archived hashes.
When expanding an existing installation, save its database and run `mise x -- just check --data --baseline path/to/baseline.sqlite` to check that every original contact remains unchanged.
The first complete import is a source snapshot, not a claim that every institution in Japan is represented.
