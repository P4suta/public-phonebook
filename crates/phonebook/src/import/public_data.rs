use super::*;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Care,
    Disability,
    Isil,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicProvider {
    id: String,
    kind: Kind,
    index_url: String,
    license_url: String,
    license: String,
    release: String,
    data_as_of: String,
    keys: Vec<String>,
}

struct Dataset {
    key: String,
    url: String,
    category: Category,
    license: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicRegistry {
    providers: Vec<PublicProvider>,
}

fn discover(provider: &PublicProvider, html: &str) -> Result<Vec<Dataset>> {
    let release = regex::escape(&provider.release);
    let pattern = Regex::new(&match provider.kind {
        Kind::Care => format!(r"^jigyosho_([0-9]{{3}})_all_{release}[0-9]{{6}}\.(?:csv|zip)$"),
        Kind::Disability => format!(r"^sfkopendata_{release}_([0-9]{{2}})\.zip$"),
        Kind::Isil => format!(r"^isil_([a-z_]+)_{release}_J\.csv$"),
    })?;
    let base = Url::parse(&provider.index_url)?;
    let document = Html::parse_document(html);
    let selector = Selector::parse("a[href]").expect("constant selector");
    let mut files = BTreeMap::new();
    for anchor in document.select(&selector) {
        let Some(url) = anchor
            .value()
            .attr("href")
            .and_then(|href| base.join(href).ok())
        else {
            continue;
        };
        let filename = url.path().rsplit('/').next().unwrap_or_default();
        let Some(captures) = pattern.captures(filename) else {
            continue;
        };
        ensure!(
            url.origin() == base.origin() && url.username().is_empty() && url.password().is_none(),
            "Dataset link leaves its publisher"
        );
        let key = captures[1].to_owned();
        if provider.kind == Kind::Isil && key == "deleted" {
            continue;
        }
        let category = match provider.kind {
            Kind::Care => Category::NursingCare,
            Kind::Disability => Category::DisabilitySupport,
            Kind::Isil => match key.as_str() {
                "libraries_public" | "libraries" => Category::Library,
                "museums" => Category::Museum,
                "archives" => Category::Archive,
                _ => bail!("Unknown institution register {key}"),
            },
        };
        let dataset = Dataset {
            key: key.clone(),
            url: url.to_string(),
            category,
            license: provider.license.clone(),
        };
        if let Some(previous) = files.insert(key, dataset) {
            ensure!(previous.url == url.as_str(), "Ambiguous dataset download");
        }
    }
    let declared: BTreeSet<_> = provider.keys.iter().cloned().collect();
    ensure!(
        !declared.is_empty()
            && declared.len() == provider.keys.len()
            && files.keys().cloned().collect::<BTreeSet<_>>() == declared,
        "Public source inventory changed for {}",
        provider.id
    );
    Ok(files.into_values().collect())
}

fn csv_contents(bytes: &[u8]) -> Result<Vec<u8>> {
    const LIMIT: u64 = 128 * 1024 * 1024;
    ensure!(bytes.len() as u64 <= LIMIT, "CSV input exceeds bound");
    if !bytes.starts_with(b"PK\x03\x04") {
        return Ok(bytes.to_owned());
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    let mut output = None;
    for index in 0..archive.len() {
        let file = archive.by_index(index)?;
        if !file.name()?.to_ascii_lowercase().ends_with(".csv") {
            continue;
        }
        ensure!(output.is_none(), "Archive contains multiple CSV files");
        ensure!(file.size() <= LIMIT, "CSV archive member exceeds bound");
        let mut contents = Vec::new();
        file.take(LIMIT + 1).read_to_end(&mut contents)?;
        ensure!(contents.len() as u64 <= LIMIT, "Expanded CSV exceeds bound");
        output = Some(contents);
    }
    output.context("Archive has no CSV data")
}

struct Columns {
    id: usize,
    name: usize,
    phone: usize,
    website: usize,
    address: Vec<usize>,
    municipality: Option<usize>,
    prefecture: Option<usize>,
}

impl Columns {
    fn read(headers: &csv::StringRecord, category: Category) -> Result<Self> {
        let unique: BTreeSet<_> = headers.iter().collect();
        ensure!(unique.len() == headers.len(), "Duplicate CSV columns");
        let column = |aliases: &[&str]| -> Result<usize> {
            let indexes: Vec<_> = headers
                .iter()
                .enumerate()
                .filter(|(_, name)| aliases.contains(name))
                .map(|(index, _)| index)
                .collect();
            ensure!(
                indexes.len() == 1,
                "Missing or ambiguous CSV column: {}",
                aliases.join(" / ")
            );
            Ok(indexes[0])
        };
        Ok(match category {
            Category::NursingCare => Self {
                id: column(&["No"])?,
                name: column(&["事業所名"])?,
                phone: column(&["電話番号"])?,
                website: column(&["URL"])?,
                address: vec![column(&["住所"])?, column(&["方書（ビル名等）"])?],
                municipality: Some(column(&["都道府県コード又は市町村コード"])?),
                prefecture: Some(column(&["都道府県名"])?),
            },
            Category::DisabilitySupport => Self {
                id: column(&["NO（※システム内の固有の番号、連番）"])?,
                name: column(&["事業所の名称"])?,
                phone: column(&["事業所電話番号"])?,
                website: column(&["事業所URL"])?,
                address: vec![
                    column(&["事業所住所（市区町村）"])?,
                    column(&["事業所住所（番地以降）"])?,
                ],
                municipality: Some(column(&["都道府県コード又は市区町村コード"])?),
                prefecture: None,
            },
            Category::Library | Category::Museum | Category::Archive => Self {
                id: column(&["ISIL"])?,
                name: column(&["機関名Institution name in Japanese"])?,
                phone: column(&["Telephone number"])?,
                website: column(&["URL"])?,
                address: vec![
                    column(&["都道府県Prefecture"])?,
                    column(&["市区町村City/Ward/Town/Village", "City/Ward/Town/Village"])?,
                    column(&["町名番地Address", "Address (Street Level)"])?,
                ],
                municipality: None,
                prefecture: Some(column(&["都道府県Prefecture"])?),
            },
            _ => bail!("Unsupported public CSV category"),
        })
    }
}

fn canonical_label(value: &str) -> String {
    store::normalized(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn issue(source: &mut SourceReport, key: &str) {
    *source.issues.entry(key.into()).or_default() += 1;
}

fn ingest_csv(
    bytes: &[u8],
    dataset: &Dataset,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let decoded = text(bytes)?;
    let mut reader = csv::Reader::from_reader(decoded.as_bytes());
    let columns = Columns::read(reader.headers()?, dataset.category)?;
    for record in reader.records() {
        source.rows += 1;
        let row = record?;
        let value = |index: usize| row[index].trim();
        let name = value(columns.name);
        let record_id = value(columns.id);
        let mut address = String::new();
        for index in &columns.address {
            let part = value(*index);
            if !part.is_empty() && !canonical_label(&address).ends_with(&canonical_label(part)) {
                if dataset.category == Category::NursingCare && !address.is_empty() {
                    address.push(' ');
                }
                address.push_str(part);
            }
        }
        if name.is_empty() || record_id.is_empty() || address.is_empty() {
            source.invalid += 1;
            issue(source, "missing_identity_or_address");
            continue;
        }
        let municipality = if let Some(index) = columns.municipality {
            let normalized = store::normalized(value(index));
            let Some(code) = phonebook_core::MunicipalityCode::parse(normalized.as_bytes()) else {
                source.invalid += 1;
                issue(source, "invalid_municipality_code");
                continue;
            };
            Some(std::str::from_utf8(code.digits())?.to_owned())
        } else {
            None
        };
        let published_prefecture = columns.prefecture.map(value);
        let prefecture = collection
            .prefectures
            .iter()
            .find(|p| {
                municipality.as_ref().map_or_else(
                    || published_prefecture == Some(p.name.as_str()),
                    |code| code.starts_with(&p.code),
                )
            })
            .cloned();
        let Some(prefecture) = prefecture else {
            source.invalid += 1;
            issue(source, "unknown_prefecture");
            continue;
        };
        if published_prefecture.is_some_and(|name| name != prefecture.name)
            || collection
                .prefectures
                .iter()
                .any(|other| address.starts_with(&other.name) && other.code != prefecture.code)
        {
            source.invalid += 1;
            issue(source, "prefecture_conflict");
            continue;
        }
        if !address.starts_with(&prefecture.name) {
            address = format!("{}{address}", prefecture.name);
        }
        let raw_phone = value(columns.phone);
        if raw_phone.is_empty() {
            source.missing_phone += 1;
            continue;
        }
        let numbers = phones(raw_phone);
        if numbers.is_empty() {
            source.invalid += 1;
            issue(source, "invalid_phone");
            continue;
        }
        let id = if matches!(
            dataset.category,
            Category::Library | Category::Museum | Category::Archive
        ) {
            let prefix = match dataset.category {
                Category::Library => "JP-1",
                Category::Museum => "JP-2",
                _ => "JP-3",
            };
            const ISIL_ID_LENGTH: usize = 10;
            const ISIL_COUNTRY_PREFIX_LENGTH: usize = 3;
            if record_id.len() != ISIL_ID_LENGTH
                || !record_id.starts_with(prefix)
                || !record_id.as_bytes()[ISIL_COUNTRY_PREFIX_LENGTH..]
                    .iter()
                    .all(u8::is_ascii_digit)
            {
                source.invalid += 1;
                issue(source, "invalid_institution_id");
                continue;
            }
            format!("isil:{record_id}")
        } else {
            let identity = serde_json::to_vec(&(
                dataset.category,
                canonical_label(name),
                canonical_label(&address),
                numbers.iter().map(|p| p.e164.as_str()).collect::<Vec<_>>(),
            ))?;
            format!("{}:{:x}", dataset.category.key(), Sha256::digest(identity))
        };
        if !matches!(
            dataset.category,
            Category::Library | Category::Museum | Category::Archive
        ) && collection.contacts.contains_key(&id)
        {
            source.duplicate += 1;
            continue;
        }
        let raw_website = value(columns.website);
        let official_url = store::web_url(raw_website);
        if !raw_website.is_empty() && official_url.is_none() {
            issue(source, "unsafe_official_url");
        }
        let municipality_code = municipality.or_else(|| {
            collection
                .region(
                    &address,
                    &prefecture.name,
                    &[prefecture.code.parse().unwrap_or(0)],
                )
                .and_then(|(_, code)| code)
        });
        collection.add(
            Contact {
                id,
                source_record_id: record_id.into(),
                prefecture_code: prefecture.code,
                prefecture: prefecture.name,
                municipality_code,
                category: dataset.category,
                name: name.into(),
                address,
                phones: numbers,
                official_url,
                source_id: source.id.clone(),
                source_url: source.url.clone(),
                license: dataset.license.clone(),
                license_url: source.license_url.clone(),
                data_as_of: source.data_as_of.clone(),
                retrieved_at: source.retrieved_at.clone(),
                official_phone_observed: false,
                official_phone_source: None,
            },
            source,
        )?;
    }
    Ok(())
}

pub(super) fn import(fetcher: &Fetcher, collection: &mut Collection) -> Result<()> {
    let registry: PublicRegistry =
        toml::from_str(include_str!("../../../../sources/public-data.toml"))?;
    let identities: BTreeSet<_> = registry.providers.iter().map(|p| &p.id).collect();
    ensure!(
        identities.len() == registry.providers.len() && !identities.is_empty(),
        "Duplicate or empty public source registry"
    );
    for provider in registry.providers {
        let index = fetcher.get(&provider.index_url, true)?;
        let index_text = text(&index.bytes)?;
        let permitted = match provider.kind {
            Kind::Care => index_text.contains("creativecommons.org/licenses/by/4.0/"),
            Kind::Disability => {
                index_text.contains("二次利用可能")
                    && index_text.contains("自由にご利用いただけます")
            }
            Kind::Isil => index_text.contains("このデータは、パブリックドメインにあります"),
        };
        ensure!(
            permitted,
            "Public source reuse statement changed for {}",
            provider.id
        );
        let files = discover(&provider, &index_text)?;
        let license = fetcher.get(&provider.license_url, false)?;
        for dataset in files {
            eprintln!("Fetching {}:{}", provider.id, dataset.key);
            let download = fetcher.get(&dataset.url, false)?;
            let bytes = csv_contents(&download.bytes)?;
            let mut source = report(
                format!("{}:{}", provider.id, dataset.key),
                &download,
                provider.data_as_of.clone(),
            );
            source.index_url = index.artifact.url.clone();
            source.index_sha256 = index.artifact.sha256.clone();
            source.license_url = license.artifact.url.clone();
            source.license_sha256 = license.artifact.sha256.clone();
            let result = ingest_csv(&bytes, &dataset, &mut source, collection);
            eprintln!(
                "{}: {} accepted, {} missing, {} invalid, {} duplicate",
                source.id, source.accepted, source.missing_phone, source.invalid, source.duplicate
            );
            collection.reports.push(source);
            result.with_context(|| {
                format!("Import public dataset {}:{}", provider.id, dataset.key)
            })?;
        }
    }
    Ok(())
}

pub(super) fn inspect(bytes: &[u8]) -> Result<()> {
    #[derive(serde::Serialize)]
    struct PhoneProfile {
        rows: usize,
        missing_phone: usize,
        invalid_phone: usize,
        invalid_examples: Vec<String>,
    }
    let decoded = text(&csv_contents(bytes)?)?;
    let mut reader = csv::Reader::from_reader(decoded.as_bytes());
    let column = reader
        .headers()?
        .iter()
        .position(|name| ["電話番号", "事業所電話番号", "Telephone number"].contains(&name))
        .context("No public contact telephone column")?;
    let mut profile = PhoneProfile {
        rows: 0,
        missing_phone: 0,
        invalid_phone: 0,
        invalid_examples: Vec::new(),
    };
    for record in reader.records() {
        let record = record?;
        profile.rows += 1;
        let phone = record[column].trim();
        if phone.is_empty() {
            profile.missing_phone += 1;
        } else if phones(phone).is_empty() {
            profile.invalid_phone += 1;
            const MAX_PROFILE_EXAMPLES: usize = 8;
            if profile.invalid_examples.len() < MAX_PROFILE_EXAMPLES
                && !profile
                    .invalid_examples
                    .iter()
                    .any(|example| example == phone)
            {
                profile.invalid_examples.push(phone.to_owned());
            }
        }
    }
    println!("{}", serde_json::to_string_pretty(&profile)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collection() -> Collection {
        Collection {
            contacts: BTreeMap::new(),
            prefectures: vec![
                Prefecture {
                    code: "13".into(),
                    name: "東京都".into(),
                },
                Prefecture {
                    code: "01".into(),
                    name: "北海道".into(),
                },
            ],
            municipalities: Vec::new(),
            reports: Vec::new(),
        }
    }

    fn source() -> SourceReport {
        SourceReport {
            id: "care:110".into(),
            url: "https://example.com/care.csv".into(),
            data_as_of: "2026-06-30".into(),
            retrieved_at: "2026-10-29T00:00:00Z".into(),
            license_url: "https://example.com/terms".into(),
            ..Default::default()
        }
    }

    fn dataset(category: Category) -> Dataset {
        Dataset {
            key: "110".into(),
            url: "https://example.com/care.csv".into(),
            category,
            license: "test".into(),
        }
    }

    const CARE: &str = "都道府県コード又は市町村コード,No,都道府県名,事業所名,住所,方書（ビル名等）,電話番号,FAX番号,URL,法人の名称\n131016,1370000001,東京都,Test care,千代田区1-2,Building 3,03-1234-5678,03-9999-9999,https://care.example/,Excluded owner\n";
    const DISABILITY: &str = "都道府県コード又は市区町村コード,NO（※システム内の固有の番号、連番）,事業所の名称,事業所住所（市区町村）,事業所住所（番地以降）,事業所電話番号,事業所FAX番号,事業所URL,法人電話番号,事業所番号\n13101,A0001,Test support,東京都千代田区,1-2,03-1234-5678,03-9999-9999,javascript:alert(1),03-8888-8888,1310000001\n";
    const LIBRARY: &str = "ISIL,機関名Institution name in Japanese,都道府県Prefecture,市区町村City/Ward/Town/Village,町名番地Address,Telephone number,代表FAX番号Fax number,URL\nJP-1000001,Test library,東京都,千代田区,1-2,03-1234-5678,03-9999-9999,https://library.example/\n";

    #[test]
    fn care_contacts_keep_the_facility_number_and_exclude_owner_and_fax_fields() {
        let mut collection = collection();
        let mut source = source();
        ingest_csv(
            CARE.as_bytes(),
            &dataset(Category::NursingCare),
            &mut source,
            &mut collection,
        )
        .unwrap();
        assert_eq!(
            (
                source.rows,
                source.accepted,
                source.invalid,
                source.missing_phone
            ),
            (1, 1, 0, 0)
        );
        let contact = collection.contacts.values().next().unwrap();
        assert_eq!(contact.name, "Test care");
        assert_eq!(contact.municipality_code.as_deref(), Some("13101"));
        assert_eq!(contact.address, "東京都千代田区1-2 Building 3");
        assert_eq!(contact.phones.len(), 1);
        assert_eq!(contact.phones[0].e164, "+81312345678");
        assert_eq!(
            contact.official_url.as_deref(),
            Some("https://care.example/")
        );
        assert!(
            !serde_json::to_string(contact)
                .unwrap()
                .contains("Excluded owner")
        );
    }

    #[test]
    fn disability_contacts_use_office_fields_and_ignore_the_corporate_telephone() {
        let mut collection = collection();
        let mut source = source();
        ingest_csv(
            DISABILITY.as_bytes(),
            &dataset(Category::DisabilitySupport),
            &mut source,
            &mut collection,
        )
        .unwrap();
        let contact = collection.contacts.values().next().unwrap();
        assert_eq!(contact.address, "東京都千代田区1-2");
        assert_eq!(contact.phones.len(), 1);
        assert_eq!(contact.phones[0].e164, "+81312345678");
        assert!(contact.official_url.is_none());
        assert_eq!(source.issues.get("unsafe_official_url"), Some(&1));
    }

    #[test]
    fn libraries_preserve_registered_identity_and_published_contact_details() {
        let mut collection = collection();
        let mut source = source();
        ingest_csv(
            LIBRARY.as_bytes(),
            &dataset(Category::Library),
            &mut source,
            &mut collection,
        )
        .unwrap();
        let contact = collection.contacts.values().next().unwrap();
        assert_eq!(contact.id, "isil:JP-1000001");
        assert_eq!(contact.address, "東京都千代田区1-2");
        assert_eq!(contact.source_record_id, "JP-1000001");
    }

    #[test]
    fn service_only_duplicates_collapse_but_shared_numbers_keep_distinct_offices() {
        let mut collection = collection();
        let mut first = source();
        ingest_csv(
            CARE.as_bytes(),
            &dataset(Category::NursingCare),
            &mut first,
            &mut collection,
        )
        .unwrap();
        let mut second = source();
        second.id = "care:430".into();
        let same = CARE
            .replace("Test care", "Ｔｅｓｔ　care")
            .replace("03-1234-5678", "0312345678");
        ingest_csv(
            same.as_bytes(),
            &dataset(Category::NursingCare),
            &mut second,
            &mut collection,
        )
        .unwrap();
        assert_eq!((second.rows, second.accepted, second.duplicate), (1, 0, 1));
        let different = CARE.replace("Test care", "Other office");
        ingest_csv(
            different.as_bytes(),
            &dataset(Category::NursingCare),
            &mut second,
            &mut collection,
        )
        .unwrap();
        assert_eq!(collection.contacts.len(), 2);
        assert_eq!(second.accepted, 1);
    }

    #[test]
    fn invalid_region_bad_checksum_and_missing_numbers_are_accounted_separately() {
        let mut collection = collection();
        let mut source = source();
        for row in [
            CARE.replace("131016", "131015"),
            CARE.replace("131016", "481016"),
            CARE.replace("03-1234-5678", ""),
            CARE.replace("03-1234-5678", "not a phone"),
            CARE.replace("東京都", "北海道"),
        ] {
            ingest_csv(
                row.as_bytes(),
                &dataset(Category::NursingCare),
                &mut source,
                &mut collection,
            )
            .unwrap();
        }
        assert_eq!(
            (
                source.rows,
                source.accepted,
                source.invalid,
                source.missing_phone
            ),
            (5, 0, 4, 1)
        );
    }

    #[test]
    fn missing_or_duplicate_required_columns_and_incomplete_records_fail_the_import() {
        for csv in [
            CARE.replace("電話番号", "Unknown column"),
            CARE.replace("FAX番号", "電話番号"),
            CARE.trim_end().to_owned() + ",extra\n",
        ] {
            assert!(
                ingest_csv(
                    csv.as_bytes(),
                    &dataset(Category::NursingCare),
                    &mut source(),
                    &mut collection()
                )
                .is_err()
            );
        }
    }

    #[test]
    fn discovery_selects_the_declared_release_and_exact_service_inventory() {
        let provider = PublicProvider {
            id: "care".into(),
            kind: Kind::Care,
            index_url: "https://example.com/catalog".into(),
            license_url: "https://example.com/terms".into(),
            license: "test".into(),
            release: "20260709".into(),
            data_as_of: "2026-06-30".into(),
            keys: vec!["110".into(), "430".into()],
        };
        let html = "<a href='/jigyosho_110_all_20260709180319.csv'>Care</a><a href='/jigyosho_430_all_20260709180320.csv'>Support</a><a href='/jigyosho_110_all_20260101000000.csv'>Previous release</a>";
        let files = discover(&provider, html).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].key, "110");
        assert_eq!(files[0].category, Category::NursingCare);
        assert!(discover(&provider, &html.replace("430", "999")).is_err());
        assert!(
            discover(
                &provider,
                &html.replace("/jigyosho_430", "https://evil.example/jigyosho_430")
            )
            .is_err()
        );
    }

    #[test]
    fn csv_archives_refuse_ambiguous_members_and_extract_without_writing_paths() {
        fn archive(names: &[&str]) -> Vec<u8> {
            let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
            for name in names {
                zip.start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(CARE.as_bytes()).unwrap();
            }
            zip.finish().unwrap().into_inner()
        }
        assert_eq!(csv_contents(CARE.as_bytes()).unwrap(), CARE.as_bytes());
        assert_eq!(
            csv_contents(&archive(&["../data.csv"])).unwrap(),
            CARE.as_bytes()
        );
        assert!(csv_contents(&archive(&["a.csv", "b.csv"])).is_err());
        assert!(csv_contents(&archive(&["a.txt"])).is_err());
        assert!(csv_contents(b"PK\x03\x04broken").is_err());
    }

    #[test]
    fn all_published_register_layouts_accept_quoted_names_and_reject_wrong_id_types() {
        let mut collection = collection();
        let mut source = source();
        let generic = LIBRARY
            .replace("市区町村City/Ward/Town/Village", "City/Ward/Town/Village")
            .replace("町名番地Address", "Address (Street Level)");
        for (category, id) in [
            (Category::Library, "JP-1000002"),
            (Category::Museum, "JP-2000001"),
            (Category::Archive, "JP-3000001"),
        ] {
            let data = generic
                .replace("JP-1000001", id)
                .replace("Test library", "\"Test, institution\nAnnex\"");
            ingest_csv(
                data.as_bytes(),
                &dataset(category),
                &mut source,
                &mut collection,
            )
            .unwrap();
        }
        assert_eq!((source.rows, source.accepted, source.invalid), (3, 3, 0));
        assert!(
            collection
                .contacts
                .values()
                .all(|contact| contact.name == "Test, institution\nAnnex")
        );
        ingest_csv(
            LIBRARY.as_bytes(),
            &dataset(Category::Museum),
            &mut source,
            &mut collection,
        )
        .unwrap();
        assert_eq!(source.invalid, 1);
    }

    #[test]
    fn disability_and_institution_discovery_ignore_older_releases_and_deleted_registers() {
        let provider = PublicProvider {
            id: "disability".into(),
            kind: Kind::Disability,
            index_url: "https://example.com/catalog".into(),
            license_url: "https://example.com/terms".into(),
            license: "test".into(),
            release: "202609".into(),
            data_as_of: "2026-09-30".into(),
            keys: vec!["11".into()],
        };
        let files = discover(&provider, "<a href='/sfkopendata_202609_11.zip'>Current</a><a href='/sfkopendata_202603_11.zip'>Previous</a>").unwrap();
        assert_eq!(files[0].category, Category::DisabilitySupport);
        let provider = PublicProvider {
            id: "isil".into(),
            kind: Kind::Isil,
            release: "20261005".into(),
            keys: vec!["libraries".into(), "museums".into(), "archives".into()],
            ..provider
        };
        let files = discover(&provider, "<a href='/isil_libraries_20261005_J.csv'>Libraries</a><a href='/isil_museums_20261005_J.csv'>Museums</a><a href='/isil_archives_20261005_J.csv'>Archives</a><a href='/isil_deleted_20261005_J.csv'>Deleted</a>").unwrap();
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].category, Category::Archive);
    }
}
