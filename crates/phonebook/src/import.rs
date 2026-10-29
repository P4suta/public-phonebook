use crate::{model::*, store};
use anyhow::{Context, Result, bail, ensure};
use calamine::Reader;
use fs2::FileExt;
use regex::Regex;
use reqwest::blocking::Client;
use scraper::{Html, Selector};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;

mod childcare;
mod civic;
mod public_data;

const MAX_SOURCE_BYTES: usize = 128 * 1024 * 1024;
const INSPECTION_ROWS: usize = 6;
const INSPECTION_COLUMNS: usize = 18;
const INSPECTION_CONTACTS: usize = 3;
const FETCH_TIMEOUT_SECONDS: u64 = 45;
const MEDICAL_INTRO_ROWS: usize = 15;
const MEDICAL_CODE_MIN_LENGTH: usize = 6;
const MEDICAL_CODE_MAX_LENGTH: usize = 14;
const UNRESOLVED_REGION_LOG_THRESHOLD: usize = 4;
const MUNICIPAL_DATA_ORIGIN: &str =
    "https://raw.githubusercontent.com/ytsubo8426/japan-municipal-offices";
const CC0_TERMS_URL: &str = "https://creativecommons.org/publicdomain/zero/1.0/";
const MEDICAL_DIRECTORY_ORIGIN: &str = "https://kouseikyoku.mhlw.go.jp";
const PREFECTURAL_WEBSITES_URL: &str = "https://code4fukui.github.io/localgovjp/prefjp.json";
const PREFECTURAL_TERMS_URL: &str = "https://www.cao.go.jp/notice/rule.html";
const COMPACT_MEDICAL_HEADER: Header = Header {
    code: (1, 2),
    name: (2, 3),
    address: (3, 4),
    phone: (4, 5),
    category: None,
};
const CATEGORY_DOWNLOAD_ORDER: [Category; 3] =
    [Category::Medical, Category::Dental, Category::Pharmacy];
const SPLIT_CATEGORY_DOWNLOAD_ORDER: [Category; 5] = [
    Category::Medical,
    Category::Medical,
    Category::Dental,
    Category::Dental,
    Category::Pharmacy,
];

const MUNICIPAL_COMMIT: &str = "6141f3d547848b5ecc333e0a9ba9e9fb80149aac";
const PREFECTURAL_SOURCE: &str =
    "https://www.bousai.go.jp/taisaku/hisaisyagyousei/pdf/kakusyuseido_tsuujou.pdf";

#[derive(Debug, Deserialize)]
pub struct Registry {
    pub providers: Vec<Provider>,
}
#[derive(Debug, Deserialize)]
pub struct Provider {
    pub id: String,
    pub url: String,
    pub prefectures: Vec<u8>,
    pub downloads: usize,
    #[serde(default)]
    pub compact_layout: bool,
}
struct Download {
    bytes: Vec<u8>,
    artifact: Artifact,
}
struct Fetcher {
    client: Client,
    cache: PathBuf,
    refresh: bool,
}

pub fn now() -> Result<String> {
    Ok(OffsetDateTime::now_utc().format(&Rfc3339)?)
}

pub fn inspect(path: &Path) -> Result<()> {
    let bytes = fs::read(path)?;
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("csv"))
    {
        return public_data::inspect(&bytes);
    }
    let mut workbooks = vec![(path.display().to_string(), bytes)];
    if workbooks[0].1.starts_with(b"PK\x03\x04") {
        let mut archive = zip::ZipArchive::new(Cursor::new(&workbooks[0].1))?;
        if archive
            .file_names()
            .any(|name| name.is_ok_and(|name| name.to_ascii_lowercase().ends_with(".csv")))
        {
            return public_data::inspect(&workbooks[0].1);
        }
        if !archive
            .file_names()
            .any(|name| name.is_ok_and(|name| name == "[Content_Types].xml"))
        {
            let mut extracted = Vec::new();
            for i in 0..archive.len() {
                let file = archive.by_index(i)?;
                let name = file.name()?.into_owned();
                if ![".xls", ".xlsx"].iter().any(|ext| name.ends_with(ext)) {
                    continue;
                }
                ensure!(
                    file.size() <= u64::try_from(MAX_SOURCE_BYTES)?,
                    "Workbook exceeds input bound"
                );
                let mut contents = Vec::new();
                file.take(u64::try_from(MAX_SOURCE_BYTES)? + 1)
                    .read_to_end(&mut contents)?;
                extracted.push((name, contents));
                if extracted.len() == 2 {
                    break;
                }
            }
            drop(archive);
            workbooks = extracted;
        }
    }
    for (name, bytes) in workbooks {
        let mut workbook = calamine::open_workbook_auto_from_rs(Cursor::new(bytes))?;
        for sheet in workbook.sheet_names().to_owned().into_iter().take(2) {
            let range = workbook.worksheet_range(&sheet)?;
            println!("{name} / {sheet}: {:?}", range.get_size());
            for row in range
                .rows()
                .filter(|row| row.iter().any(|v| !v.to_string().trim().is_empty()))
                .take(INSPECTION_ROWS)
            {
                println!(
                    "{:?}",
                    row.iter()
                        .take(INSPECTION_COLUMNS)
                        .enumerate()
                        .filter_map(|(i, v)| {
                            let value = v.to_string();
                            if value.is_empty() {
                                None
                            } else {
                                Some((i, value))
                            }
                        })
                        .collect::<Vec<_>>()
                );
            }
        }
    }
    Ok(())
}

fn inspection_collection(directory: &Path) -> Result<Collection> {
    let mut collection = Collection {
        contacts: BTreeMap::new(),
        prefectures: Vec::new(),
        municipalities: Vec::new(),
        reports: Vec::new(),
    };
    let mut reader =
        csv::Reader::from_reader(include_bytes!("../../../sources/prefectures.csv").as_slice());
    for record in reader.deserialize::<PrefectureSeed>() {
        let record = record?;
        collection.prefectures.push(Prefecture {
            code: record.code,
            name: record.name.trim_end_matches('庁').to_owned(),
        });
    }
    let database = directory.join("phonebook.sqlite");
    if database.is_file() {
        let connection = store::open(&database)?;
        let mut statement =
            connection.prepare("SELECT payload FROM contacts WHERE category='municipal_office'")?;
        for payload in statement.query_map([], |row| row.get::<_, String>(0))? {
            let contact: Contact = serde_json::from_str(&payload?)?;
            if let Some(code) = contact.municipality_code {
                collection.municipalities.push(Municipality {
                    city_code: code,
                    name: contact.name,
                    address: contact.address,
                    official_url: contact.official_url.unwrap_or_default(),
                    phone: String::new(),
                    source_url: contact.source_url,
                    verified_at: contact.data_as_of,
                });
            }
        }
    }
    Ok(collection)
}

pub fn inspect_provider(
    directory: &Path,
    path: &Path,
    provider: &str,
    prefecture: &str,
) -> Result<()> {
    let mut collection = inspection_collection(directory)?;
    let bytes = fs::read(path)?;
    let mut source = SourceReport::default();
    if provider == "childcare" {
        childcare::inspect(&bytes, &mut collection, &mut source)?;
    } else {
        civic::inspect(&bytes, provider, prefecture, &mut source, &mut collection)?;
    }
    let mut categories = BTreeMap::new();
    for contact in collection.contacts.values() {
        *categories.entry(contact.category.key()).or_insert(0usize) += 1;
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &serde_json::json!({ "report": source, "categories": categories, "sample": collection.contacts.values().take(INSPECTION_CONTACTS).collect::<Vec<_>>() })
        )?
    );
    Ok(())
}

pub fn inspect_catalog(directory: &Path, provider: &str) -> Result<()> {
    let mut collection = inspection_collection(directory)?;
    let fetcher = Fetcher::new(&directory.join("raw"), false)?;
    civic::import_selected(&fetcher, &mut collection, Some(provider))?;
    let mut categories = BTreeMap::new();
    for contact in collection.contacts.values() {
        *categories.entry(contact.category.key()).or_insert(0usize) += 1;
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &serde_json::json!({ "categories": categories, "sources": collection.reports, "sample": collection.contacts.values().take(INSPECTION_CONTACTS).collect::<Vec<_>>() })
        )?
    );
    Ok(())
}

impl Fetcher {
    fn new(directory: &Path, refresh: bool) -> Result<Self> {
        fs::create_dir_all(directory.join("objects"))?;
        Ok(Self {
            client: Client::builder()
                .https_only(true)
                .timeout(Duration::from_secs(FETCH_TIMEOUT_SECONDS))
                .user_agent("PublicPhonebook/0.1 (public-source contact directory)")
                .build()?,
            cache: directory.to_owned(),
            refresh,
        })
    }
    fn archive(&self, bytes: &[u8], artifact: &Artifact) -> Result<()> {
        let path = self
            .cache
            .join("objects")
            .join(format!("{}.bin", artifact.sha256));
        if path.is_file() {
            ensure!(
                format!("{:x}", Sha256::digest(fs::read(path)?)) == artifact.sha256,
                "Archived source identity mismatch"
            );
        } else {
            let mut file = tempfile::NamedTempFile::new_in(self.cache.join("objects"))?;
            file.write_all(bytes)?;
            file.persist(path)?;
        }
        Ok(())
    }
    fn get(&self, url: &str, always_refresh: bool) -> Result<Download> {
        let parsed = Url::parse(url)?;
        ensure!(
            parsed.scheme() == "https"
                && parsed.username().is_empty()
                && parsed.password().is_none(),
            "Only public HTTPS source URLs are supported"
        );
        let key = format!("{:x}", Sha256::digest(url.as_bytes()));
        let metadata = self.cache.join(format!("{key}.json"));
        let body = self.cache.join(format!("{key}.bin"));
        if !self.refresh && !always_refresh && metadata.is_file() && body.is_file() {
            let artifact: Artifact = serde_json::from_slice(&fs::read(metadata)?)?;
            let bytes = fs::read(body)?;
            ensure!(
                artifact.url == url && artifact.sha256 == format!("{:x}", Sha256::digest(&bytes)),
                "Cached source identity mismatch"
            );
            self.archive(&bytes, &artifact)?;
            return Ok(Download { bytes, artifact });
        }
        let response = self
            .client
            .get(url)
            .send()
            .with_context(|| format!("Fetch {url}"))?
            .error_for_status()?;
        let mut bytes = Vec::new();
        response
            .take(u64::try_from(MAX_SOURCE_BYTES)? + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= MAX_SOURCE_BYTES,
            "Source exceeds the 128 MiB input bound"
        );
        self.save(url, bytes)
    }
    fn save(&self, url: &str, bytes: Vec<u8>) -> Result<Download> {
        ensure!(
            bytes.len() <= MAX_SOURCE_BYTES,
            "Source exceeds input bound"
        );
        let key = format!("{:x}", Sha256::digest(url.as_bytes()));
        let metadata = self.cache.join(format!("{key}.json"));
        let body = self.cache.join(format!("{key}.bin"));
        let artifact = Artifact {
            url: url.to_owned(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            retrieved_at: now()?,
        };
        self.archive(&bytes, &artifact)?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.cache)?;
        temporary.write_all(&bytes)?;
        temporary.persist(&body)?;
        fs::write(metadata, serde_json::to_vec_pretty(&artifact)?)?;
        Ok(Download { bytes, artifact })
    }
}

fn text(bytes: &[u8]) -> Result<String> {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    if let Ok(value) = std::str::from_utf8(bytes) {
        return Ok(value.to_owned());
    }
    let (decoded, errors) = encoding_rs::SHIFT_JIS.decode_without_bom_handling(bytes);
    ensure!(!errors, "Input has undecodable bytes");
    Ok(decoded.into_owned())
}

fn date(input: &str) -> String {
    const DAY_CAPTURE_INDEX: usize = 3;
    const SOURCE_ERA_YEAR_OFFSET: i32 = 2018;
    let normalized = store::normalized(input);
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = PATTERN.get_or_init(|| {
        Regex::new(r"令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")
            .expect("constant regex")
    });
    if let Some(c) = re.captures(&normalized) {
        let era = c[1].parse::<i32>().unwrap_or(0);
        let month = c[2].parse::<u8>().unwrap_or(0);
        let day = c[DAY_CAPTURE_INDEX].parse::<u8>().unwrap_or(0);
        if era > 0
            && let Ok(month) = time::Month::try_from(month)
            && let Ok(value) =
                time::Date::from_calendar_date(era + SOURCE_ERA_YEAR_OFFSET, month, day)
        {
            return value.to_string();
        }
    }
    "Not specified by source".to_owned()
}

fn append_phone_run(input: &str, output: &mut BTreeMap<String, Phone>) {
    let variants = match phonebook_core::normalize_phone(input) {
        Ok(e164) => vec![Phone {
            original: input.trim().to_owned(),
            e164: String::from(e164),
        }],
        Err(_) => {
            let parts = input
                .split_whitespace()
                .map(|part| {
                    phonebook_core::normalize_phone(part).map(|e164| Phone {
                        original: part.to_owned(),
                        e164: String::from(e164),
                    })
                })
                .collect::<std::result::Result<Vec<_>, _>>();
            let Ok(parts) = parts else {
                return;
            };
            if parts.len() < 2 {
                return;
            }
            parts
        }
    };
    for phone in variants {
        output.entry(phone.e164.clone()).or_insert(phone);
    }
}

pub fn phones(input: &str) -> Vec<Phone> {
    use phonebook_core::{PhoneCharacter, classify_phone_character};
    let mut output = BTreeMap::new();
    static FAX: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let fax = FAX.get_or_init(|| {
        Regex::new("(?i:fax|ｆａｘ)|ファックス|ファクシミリ").expect("constant regex")
    });
    for line in input.lines() {
        let before_fax = fax.find(line).map_or(line, |found| &line[..found.start()]);
        let mut start = None;
        let mut digit_end = 0;
        for (index, character) in before_fax.char_indices() {
            match classify_phone_character(character) {
                PhoneCharacter::Digit(_) => {
                    start.get_or_insert(index);
                    digit_end = index + character.len_utf8();
                }
                PhoneCharacter::Separator => {}
                boundary => {
                    if let Some(begin) = start
                        && digit_end > begin
                    {
                        append_phone_run(&before_fax[begin..digit_end], &mut output);
                    }
                    start = (boundary == PhoneCharacter::InternationalPrefix).then_some(index);
                    digit_end = index;
                }
            }
        }
        if let Some(begin) = start
            && digit_end > begin
        {
            append_phone_run(&before_fax[begin..digit_end], &mut output);
        }
    }
    output.into_values().collect()
}

#[derive(Debug, Clone, Deserialize)]
struct Municipality {
    city_code: String,
    name: String,
    address: String,
    phone: String,
    official_url: String,
    source_url: String,
    verified_at: String,
}
#[derive(Debug, Deserialize)]
struct Catalog {
    pref_code: String,
    pref_name: String,
    dataset: String,
}
#[derive(Debug, Deserialize)]
struct PrefectureSeed {
    code: String,
    name: String,
    phone: String,
    address: String,
}

struct Collection {
    contacts: BTreeMap<String, Contact>,
    prefectures: Vec<Prefecture>,
    municipalities: Vec<Municipality>,
    reports: Vec<SourceReport>,
}

impl Collection {
    fn add(&mut self, contact: Contact, report: &mut SourceReport) -> Result<()> {
        if contact.phones.is_empty() {
            report.missing_phone += 1;
            return Ok(());
        }
        if let Some(existing) = self.contacts.get(&contact.id) {
            ensure!(
                existing.name == contact.name
                    && existing.address == contact.address
                    && existing.phones == contact.phones,
                "Conflicting facility identity {}",
                contact.id
            );
            report.duplicate += 1;
        } else {
            self.contacts.insert(contact.id.clone(), contact);
            report.accepted += 1;
        }
        Ok(())
    }
    fn region(
        &self,
        address: &str,
        context: &str,
        allowed: &[u8],
    ) -> Option<(Prefecture, Option<String>)> {
        let address = store::normalized(address);
        let candidates: Vec<_> = self
            .prefectures
            .iter()
            .filter(|p| p.code.parse::<u8>().is_ok_and(|n| allowed.contains(&n)))
            .collect();
        let explicit = candidates
            .iter()
            .filter_map(|p| address.find(&p.name).map(|position| (position, *p)))
            .min_by_key(|(position, _)| *position)
            .map(|(_, prefecture)| prefecture);
        let context_prefecture = candidates
            .iter()
            .find(|p| {
                context.contains(&p.name)
                    || context.contains(p.name.trim_end_matches(['県', '府', '都']))
            })
            .copied();
        let known = explicit.or(context_prefecture).or_else(|| {
            if candidates.len() == 1 {
                candidates.first().copied()
            } else {
                None
            }
        });
        let city = self.municipalities.iter().find(|m| {
            let name = m.name.trim_end_matches("役所").trim_end_matches("役場");
            m.city_code.get(..2).is_some_and(|prefix| {
                known.map_or_else(
                    || candidates.iter().any(|p| p.code == prefix),
                    |p| p.code == prefix,
                )
            }) && !name.is_empty()
                && address.contains(name)
        });
        let prefecture = known.or_else(|| {
            city.and_then(|m| {
                candidates
                    .iter()
                    .find(|p| m.city_code.starts_with(&p.code))
                    .copied()
            })
        })?;
        Some((prefecture.clone(), city.map(|m| m.city_code.clone())))
    }
}

fn report(id: String, download: &Download, as_of: String) -> SourceReport {
    SourceReport {
        id,
        url: download.artifact.url.clone(),
        sha256: download.artifact.sha256.clone(),
        data_as_of: as_of,
        retrieved_at: download.artifact.retrieved_at.clone(),
        ..SourceReport::default()
    }
}

fn municipalities(fetcher: &Fetcher) -> Result<Collection> {
    let base = format!("{MUNICIPAL_DATA_ORIGIN}/{MUNICIPAL_COMMIT}");
    let catalog = fetcher.get(&format!("{base}/catalog.csv"), false)?;
    let license = fetcher.get(&format!("{base}/LICENSE"), false)?;
    ensure!(
        text(&license.bytes)?.contains("CC0"),
        "Municipal source license changed"
    );
    let catalogs: Vec<Catalog> = csv::Reader::from_reader(text(&catalog.bytes)?.as_bytes())
        .deserialize()
        .collect::<std::result::Result<_, _>>()?;
    let expected: BTreeSet<_> = (1..=PREFECTURE_COUNT).map(|n| format!("{n:02}")).collect();
    ensure!(
        catalogs
            .iter()
            .map(|r| format!("{:02}", r.pref_code.parse::<u8>().unwrap_or(0)))
            .collect::<BTreeSet<_>>()
            == expected,
        "Municipal catalog must contain exactly prefectures 01 through 47"
    );
    let mut collection = Collection {
        contacts: BTreeMap::new(),
        prefectures: Vec::new(),
        municipalities: Vec::new(),
        reports: Vec::new(),
    };
    for row in catalogs {
        let prefecture_name = row.pref_name.clone();
        let code = format!("{:02}", row.pref_code.parse::<u8>()?);
        ensure!(
            row.dataset.ends_with(".csv")
                && row
                    .dataset
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '.'),
            "Invalid dataset filename"
        );
        collection.prefectures.push(Prefecture {
            code: code.clone(),
            name: row.pref_name.clone(),
        });
        let download = fetcher.get(&format!("{base}/{}", row.dataset), false)?;
        let mut source = report(
            format!("municipal-{code}"),
            &download,
            format!("Commit {MUNICIPAL_COMMIT}"),
        );
        source.index_url = catalog.artifact.url.clone();
        source.index_sha256 = catalog.artifact.sha256.clone();
        source.license_url = license.artifact.url.clone();
        source.license_sha256 = license.artifact.sha256.clone();
        let decoded = text(&download.bytes)?;
        for row in csv::Reader::from_reader(decoded.as_bytes()).deserialize::<Municipality>() {
            let row = row?;
            source.rows += 1;
            ensure!(
                row.city_code.len() == MUNICIPALITY_CODE_LENGTH && row.city_code.starts_with(&code),
                "Invalid municipality identity {}",
                row.city_code
            );
            let numbers = phones(&row.phone);
            if numbers.is_empty() && !row.phone.trim().is_empty() {
                source.invalid += 1;
                *source.issues.entry("invalid_phone".into()).or_default() += 1;
                collection.municipalities.push(row);
                continue;
            }
            collection.add(
                Contact {
                    id: format!("municipal:{}", row.city_code),
                    source_record_id: row.city_code.clone(),
                    prefecture_code: code.clone(),
                    prefecture: prefecture_name.clone(),
                    municipality_code: Some(row.city_code.clone()),
                    category: Category::MunicipalOffice,
                    name: row.name.clone(),
                    address: format!("{}{}", prefecture_name, row.address),
                    phones: numbers,
                    official_url: Some(row.official_url.clone()),
                    source_id: source.id.clone(),
                    source_url: row.source_url.clone(),
                    license: "CC0-1.0".into(),
                    license_url: CC0_TERMS_URL.into(),
                    data_as_of: row.verified_at.clone(),
                    retrieved_at: source.retrieved_at.clone(),
                    official_phone_observed: false,
                    official_phone_source: None,
                },
                &mut source,
            )?;
            collection.municipalities.push(row);
        }
        collection.reports.push(source);
    }
    collection
        .municipalities
        .sort_by_key(|m| std::cmp::Reverse(m.name.len()));
    collection.prefectures.sort_by(|a, b| a.code.cmp(&b.code));
    Ok(collection)
}

fn hint(input: &str) -> Option<Category> {
    let value = store::normalized(input);
    if value.contains("薬局") || value.contains("yakkyoku") || value.contains("調剤") {
        Some(Category::Pharmacy)
    } else if value.contains("shikaheisetsu") || value.contains("歯科併設") {
        Some(Category::Medical)
    } else if value.contains("ikaheisetsu")
        || value.contains("医科併設")
        || value.contains("歯科")
        || value.contains("shika")
        || value.contains("sika")
    {
        Some(Category::Dental)
    } else if value.contains("医科") || value.contains("ika") {
        Some(Category::Medical)
    } else {
        None
    }
}

#[derive(Debug)]
struct Header {
    code: (usize, usize),
    name: (usize, usize),
    address: (usize, usize),
    phone: (usize, usize),
    category: Option<(usize, usize)>,
}

fn header(row: &[String]) -> Option<Header> {
    let filled: Vec<_> = row
        .iter()
        .enumerate()
        .filter_map(|(i, v)| {
            let value: String = store::normalized(v)
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            if value.is_empty() {
                None
            } else {
                Some((i, value))
            }
        })
        .collect();
    let band = |predicate: fn(&str) -> bool| -> Option<(usize, usize)> {
        let position = filled.iter().position(|(_, v)| predicate(v))?;
        Some((
            filled[position].0,
            filled.get(position + 1).map(|v| v.0).unwrap_or(row.len()),
        ))
    };
    Some(Header {
        code: band(|v| {
            v.contains("医療機関番号") || v.contains("医療機関コード") || v == "薬局番号"
        })?,
        name: band(|v| {
            v.contains("医療機関名称") || v.contains("医療機関名") || v.contains("薬局名称")
        })?,
        address: band(|v| v.contains("所在地") || v == "住所")?,
        phone: band(|v| v.starts_with("電話"))?,
        category: band(|v| v.contains("点数表")),
    })
}

fn field(row: &[String], band: (usize, usize)) -> String {
    row.get(band.0..band.1.min(row.len()))
        .unwrap_or(&[])
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn workbook(
    bytes: Vec<u8>,
    name: &str,
    fallback: Option<Category>,
    provider: &Provider,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<usize> {
    let mut workbook = calamine::open_workbook_auto_from_rs(Cursor::new(bytes))?;
    let mut seen = 0;
    let mut tables = 0;
    for sheet in workbook.sheet_names().to_owned() {
        let range = workbook.worksheet_range(&sheet)?;
        let intro = range
            .rows()
            .take(MEDICAL_INTRO_ROWS)
            .flat_map(|row| row.iter().map(ToString::to_string))
            .collect::<Vec<_>>()
            .join(" ");
        let heading = range
            .rows()
            .filter(|row| row.iter().any(|v| !v.to_string().trim().is_empty()))
            .take(2)
            .flat_map(|row| row.iter().map(ToString::to_string))
            .collect::<Vec<_>>()
            .join(" ");
        let region_context = format!("{name} {sheet} {heading}");
        let context = format!("{region_context} {intro}");
        let as_of = date(&context);
        let mut layout = if provider.compact_layout
            && context.contains("コード内容別医療機関一覧表")
        {
            tables += 1;
            Some(COMPACT_MEDICAL_HEADER)
        } else {
            None
        };
        for cells in range.rows() {
            let row: Vec<_> = cells.iter().map(ToString::to_string).collect();
            if let Some(value) = header(&row) {
                layout = Some(value);
                tables += 1;
                continue;
            }
            let Some(layout) = &layout else {
                continue;
            };
            let code_raw = field(&row, layout.code);
            let code: String = store::normalized(&code_raw)
                .chars()
                .filter(char::is_ascii_digit)
                .collect();
            if code.len() < MEDICAL_CODE_MIN_LENGTH || code.len() > MEDICAL_CODE_MAX_LENGTH {
                continue;
            }
            let title = field(&row, layout.name).replace(['\r', '\n'], " ");
            if title.is_empty() {
                continue;
            }
            source.rows += 1;
            seen += 1;
            let address = field(&row, layout.address).replace(['\r', '\n'], " ");
            let raw_phone = field(&row, layout.phone);
            let numbers = phones(&raw_phone);
            if numbers.is_empty() {
                if raw_phone.trim().is_empty() {
                    source.missing_phone += 1;
                } else {
                    source.invalid += 1;
                    *source.issues.entry("invalid_phone".into()).or_default() += 1;
                }
                continue;
            }
            let row_category = layout.category.map(|band| field(&row, band));
            let category = row_category
                .as_deref()
                .and_then(|s| match s.trim() {
                    "医" => Some(Category::Medical),
                    "歯" => Some(Category::Dental),
                    "調" | "調剤" => Some(Category::Pharmacy),
                    _ => None,
                })
                .or_else(|| hint(name))
                .or(fallback)
                .or_else(|| hint(&context))
                .context("Unable to identify medical category")?;
            let Some((prefecture, municipality_code)) =
                collection.region(&address, &region_context, &provider.prefectures)
            else {
                source.invalid += 1;
                *source
                    .issues
                    .entry("unresolved_prefecture".into())
                    .or_default() += 1;
                if source
                    .issues
                    .get("unresolved_prefecture")
                    .copied()
                    .unwrap_or(0)
                    < UNRESOLVED_REGION_LOG_THRESHOLD
                {
                    eprintln!("Unresolved region: {} {name} {address}", provider.id);
                }
                continue;
            };
            collection.add(
                Contact {
                    id: format!("medical:{}:{}:{code}", prefecture.code, category.key()),
                    source_record_id: code,
                    prefecture_code: prefecture.code,
                    prefecture: prefecture.name,
                    municipality_code,
                    category,
                    name: title,
                    address,
                    phones: numbers,
                    official_url: None,
                    source_id: source.id.clone(),
                    source_url: source.url.clone(),
                    license: "PDL-1.0".into(),
                    license_url: source.license_url.clone(),
                    data_as_of: as_of.clone(),
                    retrieved_at: source.retrieved_at.clone(),
                    official_phone_observed: false,
                    official_phone_source: None,
                },
                source,
            )?;
        }
    }
    ensure!(
        tables > 0 && seen > 0,
        "No telephone-bearing facility table recognized in {name}"
    );
    Ok(seen)
}

fn medical_file(
    bytes: Vec<u8>,
    name: &str,
    fallback: Option<Category>,
    provider: &Provider,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    if bytes.starts_with(b"PK\x03\x04") && !name.to_lowercase().ends_with(".xlsx") {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
        let mut found = 0;
        for i in 0..archive.len() {
            let file = archive.by_index(i)?;
            let filename = file.name()?.into_owned();
            if ![".xls", ".xlsx", ".xlsm"]
                .iter()
                .any(|ext| filename.to_lowercase().ends_with(ext))
            {
                continue;
            }
            ensure!(
                file.size() <= u64::try_from(MAX_SOURCE_BYTES)?,
                "Workbook exceeds input bound"
            );
            let mut contents = Vec::new();
            file.take(u64::try_from(MAX_SOURCE_BYTES)? + 1)
                .read_to_end(&mut contents)?;
            workbook(
                contents,
                &filename,
                hint(&filename).or(fallback),
                provider,
                source,
                collection,
            )
            .with_context(|| format!("Parse {filename} from {}", source.url))?;
            found += 1;
        }
        ensure!(found > 0, "Archive contains no supported workbooks: {name}");
    } else {
        workbook(bytes, name, fallback, provider, source, collection)?;
    }
    Ok(())
}

fn medical(fetcher: &Fetcher, provider: &Provider, collection: &mut Collection) -> Result<()> {
    eprintln!("Fetching medical region {}", provider.id);
    let page = fetcher.get(&provider.url, true)?;
    let license_url = format!(
        "{MEDICAL_DIRECTORY_ORIGIN}/{}/aboutus/copyright.html",
        provider.id
    );
    let license = fetcher.get(&license_url, false)?;
    let policy = text(&license.bytes)?;
    ensure!(
        policy.contains("PDL1.0") || policy.contains("公共データ利用規約"),
        "Source license changed for {}",
        provider.id
    );
    let html = text(&page.bytes)?;
    let document = Html::parse_document(&html);
    let selector = Selector::parse("a[href]").expect("constant selector");
    let base = Url::parse(&provider.url)?;
    let mut urls = Vec::new();
    for link in document.select(&selector) {
        let Some(href) = link.value().attr("href") else {
            continue;
        };
        let Ok(url) = base.join(href) else { continue };
        let path = url.path().to_lowercase();
        if ![".zip", ".xls", ".xlsx"]
            .iter()
            .any(|ext| path.ends_with(ext))
        {
            continue;
        }
        let selected = match provider.id.as_str() {
            "tohoku" => {
                path.contains("shitei-touhoku-")
                    && [
                        "-ika-",
                        "-shika-",
                        "-shikaheisetsu-",
                        "-ikaheisetsu-",
                        "-yakkyoku-",
                    ]
                    .iter()
                    .any(|p| path.contains(p))
            }
            "kantoshinetsu" => path.contains("/shitei_"),
            "kinki" => path.contains("kikanzentai"),
            _ => true,
        };
        if selected && !urls.contains(&url) {
            urls.push(url);
        }
        if urls.len() == provider.downloads {
            break;
        }
    }
    ensure!(
        urls.len() == provider.downloads,
        "{} source inventory changed: found {}, expected {}",
        provider.id,
        urls.len(),
        provider.downloads
    );
    let page_text = document.root_element().text().collect::<Vec<_>>().join(" ");
    for (index, url) in urls.into_iter().enumerate() {
        let download = fetcher.get(url.as_str(), false)?;
        let mut source = report(
            format!("{}-{index}", provider.id),
            &download,
            date(&page_text),
        );
        source.index_url = provider.url.clone();
        source.index_sha256 = page.artifact.sha256.clone();
        source.license_url = license_url.clone();
        source.license_sha256 = license.artifact.sha256.clone();
        let fallback = if provider.downloads == CATEGORY_DOWNLOAD_ORDER.len() {
            CATEGORY_DOWNLOAD_ORDER.get(index).copied()
        } else if provider.downloads == SPLIT_CATEGORY_DOWNLOAD_ORDER.len() {
            SPLIT_CATEGORY_DOWNLOAD_ORDER.get(index).copied()
        } else {
            None
        };
        medical_file(
            download.bytes,
            url.path(),
            hint(url.path()).or(fallback),
            provider,
            &mut source,
            collection,
        )?;
        eprintln!(
            "{}: {} accepted, {} missing, {} invalid, {} duplicate",
            source.id, source.accepted, source.missing_phone, source.invalid, source.duplicate
        );
        collection.reports.push(source);
    }
    Ok(())
}

fn prefectures(fetcher: &Fetcher, collection: &mut Collection) -> Result<()> {
    let directory = fetcher.get(PREFECTURAL_WEBSITES_URL, false)?;
    let websites: Vec<serde_json::Value> = serde_json::from_slice(&directory.bytes)?;
    let source_document = fetcher.get(PREFECTURAL_SOURCE, false)?;
    let mut source = report(
        "prefectural-offices".into(),
        &source_document,
        "2026-06-01".into(),
    );
    let license = fetcher.get(PREFECTURAL_TERMS_URL, false)?;
    source.license_url = license.artifact.url;
    source.license_sha256 = license.artifact.sha256;
    source.artifacts.push(directory.artifact);
    let confirmation_pages: BTreeMap<String, String> = toml::from_str(include_str!(
        "../../../sources/prefecture-confirmation.toml"
    ))?;
    let mut reader =
        csv::Reader::from_reader(include_bytes!("../../../sources/prefectures.csv").as_slice());
    for row in reader.deserialize::<PrefectureSeed>() {
        let row = row?;
        let prefecture = collection
            .prefectures
            .iter()
            .find(|p| p.code == row.code)
            .context("Unknown prefecture code")?
            .clone();
        let pid = row.code.parse::<u64>()?;
        let website = websites
            .iter()
            .find(|site| {
                site["pid"].as_u64() == Some(pid)
                    || site["pid"]
                        .as_str()
                        .is_some_and(|v| v.parse::<u64>() == Ok(pid))
            })
            .and_then(|site| site["url"].as_str())
            .context("Missing official prefectural website")?
            .replace("http://", "https://");
        let numbers = phones(&row.phone);
        let mut observed = false;
        let confirmation_url = confirmation_pages
            .get(&row.code)
            .cloned()
            .unwrap_or_else(|| website.clone());
        if let Ok(page) = fetcher.get(&confirmation_url, false) {
            let doc = Html::parse_document(&text(&page.bytes)?);
            let plain = doc.root_element().text().collect::<Vec<_>>().join("\n");
            observed = phones(&plain)
                .iter()
                .any(|p| numbers.iter().any(|n| n.e164 == p.e164));
            if !observed {
                let selector = Selector::parse("a[href^='tel:']").expect("constant selector");
                observed = doc
                    .select(&selector)
                    .filter_map(|a| a.value().attr("href"))
                    .flat_map(|v| phones(v.trim_start_matches("tel:")))
                    .any(|p| numbers.iter().any(|n| n.e164 == p.e164));
            }
            source.artifacts.push(page.artifact);
        }
        if !observed {
            *source
                .issues
                .entry("official_homepage_not_confirmed".into())
                .or_default() += 1;
        }
        source.rows += 1;
        collection.add(
            Contact {
                id: format!("prefecture:{}", row.code),
                source_record_id: row.code.clone(),
                prefecture_code: row.code,
                prefecture: prefecture.name,
                municipality_code: None,
                category: Category::PrefecturalOffice,
                name: row.name,
                address: row.address,
                phones: numbers,
                official_url: Some(website),
                source_id: source.id.clone(),
                source_url: PREFECTURAL_SOURCE.into(),
                license: "PDL-1.0".into(),
                license_url: PREFECTURAL_TERMS_URL.into(),
                data_as_of: source.data_as_of.clone(),
                retrieved_at: source.retrieved_at.clone(),
                official_phone_observed: observed,
                official_phone_source: observed.then(|| confirmation_url.clone()),
            },
            &mut source,
        )?;
    }
    ensure!(
        source.rows == PREFECTURE_COUNT,
        "Prefectural source must contain 47 offices"
    );
    collection.reports.push(source);
    Ok(())
}

pub fn lock(directory: &Path, exclusive: bool) -> Result<File> {
    let file = if !exclusive && directory.join("directory.lock").is_file() {
        File::open(directory.join("directory.lock"))?
    } else {
        fs::create_dir_all(directory)?;
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("directory.lock"))?
    };
    if exclusive {
        file.try_lock_exclusive()
    } else {
        FileExt::try_lock_shared(&file)
    }
    .context("Stop the running server before updating data")?;
    Ok(file)
}

pub fn update(directory: &Path, refresh: bool) -> Result<Coverage> {
    let _lock = lock(directory, true)?;
    let fetcher = Fetcher::new(&directory.join("raw"), refresh)?;
    let mut collection = municipalities(&fetcher)?;
    let registry: Registry = toml::from_str(include_str!("../../../sources/medical.toml"))?;
    let declared: BTreeSet<_> = registry
        .providers
        .iter()
        .flat_map(|p| p.prefectures.iter().copied())
        .collect();
    ensure!(
        declared == (1..=u8::try_from(PREFECTURE_COUNT)?).collect(),
        "Medical inventory must cover exactly all 47 prefectures"
    );
    let result: Result<()> = (|| {
        for provider in &registry.providers {
            medical(&fetcher, provider, &mut collection)?;
        }
        prefectures(&fetcher, &mut collection)?;
        public_data::import(&fetcher, &mut collection)?;
        childcare::import(&fetcher, &mut collection)?;
        civic::import(&fetcher, &mut collection)
    })();
    if let Err(error) = result {
        fs::write(
            directory.join("latest-import-report.json"),
            serde_json::to_vec_pretty(
                &serde_json::json!({"complete": false, "error": format!("{error:#}"), "sources": collection.reports}),
            )?,
        )?;
        return Err(error.context("Import failed; previous database preserved"));
    }
    let contacts: Vec<_> = collection.contacts.into_values().collect();
    let coverage = store::coverage(
        &contacts,
        &collection.prefectures,
        collection.reports,
        now()?,
    );
    fs::write(
        directory.join("latest-import-report.json"),
        serde_json::to_vec_pretty(&coverage)?,
    )?;
    if !coverage.complete {
        for cell in &coverage.cells {
            if cell.contacts == 0 {
                eprintln!(
                    "Missing coverage: {} {}",
                    cell.prefecture,
                    cell.category.key()
                );
            }
        }
        bail!(
            "National import incomplete: {}/47 prefectures; previous database preserved",
            coverage.prefectures_covered
        );
    }
    store::stage_snapshot(directory, &contacts, &coverage)?
        .persist(directory.join("phonebook.sqlite"))?;
    fs::write(
        directory.join("coverage.json"),
        serde_json::to_vec_pretty(&coverage)?,
    )?;
    Ok(coverage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefecture_resolution_uses_the_first_address_component() {
        let collection = Collection {
            contacts: BTreeMap::new(),
            prefectures: vec![
                Prefecture {
                    code: "04".into(),
                    name: "宮城県".into(),
                },
                Prefecture {
                    code: "13".into(),
                    name: "東京都".into(),
                },
            ],
            municipalities: Vec::new(),
            reports: Vec::new(),
        };
        let result = collection
            .region("〒100-0000東京都千代田区宮城県会館", "東京都", &[4, 13])
            .unwrap();
        assert_eq!(result.0.code, "13");
    }

    #[test]
    fn all_fax_labels_end_the_telephone_part_of_a_line() {
        for label in [
            "FAX",
            "Fax",
            "fax",
            "ＦＡＸ",
            "ｆａｘ",
            "ファックス",
            "ファクシミリ",
        ] {
            let values = phones(&format!("03-5321-1111 {label} 03-5321-1112"));
            assert_eq!(values.len(), 1, "{label}");
            assert_eq!(values[0].e164, "+81353211111");
        }
    }

    #[test]
    fn source_dates_are_valid_calendar_dates() {
        assert_eq!(date("令和８年１０月１日現在"), "2026-10-01");
        assert_eq!(date("令和 6年2月29日"), "2024-02-29");
        for value in [
            "令和0年1月1日",
            "令和8年13月1日",
            "令和8年2月29日",
            "令和8年1月32日",
            "No source date",
        ] {
            assert_eq!(date(value), "Not specified by source", "{value}");
        }
    }

    #[test]
    fn medical_categories_follow_the_published_table_names() {
        for (name, expected) in [
            ("shitei_ika.xlsx", Category::Medical),
            ("歯科併設医科.xlsx", Category::Medical),
            ("shitei_shikaheisetsu.xlsx", Category::Medical),
            ("医科併設歯科.xlsx", Category::Dental),
            ("shitei_ikaheisetsu.xlsx", Category::Dental),
            ("shika.xlsx", Category::Dental),
            ("sika.xlsx", Category::Dental),
            ("薬局.xlsx", Category::Pharmacy),
            ("yakkyoku.xlsx", Category::Pharmacy),
        ] {
            assert_eq!(hint(name), Some(expected), "{name}");
        }
        assert_eq!(hint("unknown.xlsx"), None);
    }

    #[test]
    fn source_text_decoding_is_strict_and_preserves_japanese() {
        assert_eq!(text(b"\xef\xbb\xbfheader").unwrap(), "header");
        assert_eq!(
            text(&[0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]).unwrap(),
            "日本語"
        );
        assert!(text(&[0x81]).is_err());
    }

    #[test]
    fn nonpublic_transports_and_url_credentials_are_refused_before_fetching() {
        let directory = tempfile::tempdir().unwrap();
        let fetcher = Fetcher::new(directory.path(), false).unwrap();
        for url in [
            "http://example.com/data",
            "ftp://example.com/data",
            "file:///tmp/data",
            "https://user:secret@example.com/data",
        ] {
            let error = fetcher.get(url, false).err().unwrap().to_string();
            assert!(error.contains("Only public HTTPS"));
            assert!(!error.contains("secret"));
        }
    }

    #[test]
    fn source_transport_refuses_http_before_connecting() {
        let directory = tempfile::tempdir().unwrap();
        let fetcher = Fetcher::new(directory.path(), false).unwrap();
        let error = fetcher
            .client
            .get("http://127.0.0.1:0/blocked")
            .send()
            .unwrap_err();
        assert!(
            error.is_builder(),
            "The transport must reject HTTP before connecting"
        );
    }

    #[test]
    fn cache_refresh_keeps_both_immutable_source_snapshots() {
        let directory = tempfile::tempdir().unwrap();
        let fetcher = Fetcher::new(directory.path(), false).unwrap();
        let url = "https://example.com/data";
        let key = format!("{:x}", Sha256::digest(url.as_bytes()));
        for bytes in [b"snapshot one", b"snapshot two"] {
            let artifact = Artifact {
                url: url.into(),
                sha256: format!("{:x}", Sha256::digest(bytes)),
                retrieved_at: "fixed".into(),
            };
            fs::write(fetcher.cache.join(format!("{key}.bin")), bytes).unwrap();
            fs::write(
                fetcher.cache.join(format!("{key}.json")),
                serde_json::to_vec(&artifact).unwrap(),
            )
            .unwrap();
            assert_eq!(fetcher.get(url, false).unwrap().bytes, bytes);
        }
        for bytes in [b"snapshot one", b"snapshot two"] {
            let hash = format!("{:x}", Sha256::digest(bytes));
            assert_eq!(
                fs::read(fetcher.cache.join("objects").join(format!("{hash}.bin"))).unwrap(),
                bytes
            );
        }
    }

    #[test]
    fn conflicting_facility_identities_fail_without_merging_by_phone() {
        let mut collection = Collection {
            contacts: BTreeMap::new(),
            prefectures: Vec::new(),
            municipalities: Vec::new(),
            reports: Vec::new(),
        };
        let mut contact = crate::model::Contact {
            id: "test".into(),
            source_record_id: "test".into(),
            prefecture_code: "13".into(),
            prefecture: "東京都".into(),
            municipality_code: None,
            category: Category::Medical,
            name: "Test clinic".into(),
            address: "Test address".into(),
            phones: phones("03-5321-1111"),
            official_url: None,
            source_id: "test".into(),
            source_url: "https://example.com/".into(),
            license: "test".into(),
            license_url: "https://example.com/".into(),
            data_as_of: "fixed".into(),
            retrieved_at: "fixed".into(),
            official_phone_observed: false,
            official_phone_source: None,
        };
        let mut report = SourceReport::default();
        collection.add(contact.clone(), &mut report).unwrap();
        collection.add(contact.clone(), &mut report).unwrap();
        assert_eq!((report.accepted, report.duplicate), (1, 1));
        contact.name = "Different clinic".into();
        assert!(collection.add(contact.clone(), &mut report).is_err());
        contact.id = "different institution".into();
        collection.add(contact, &mut report).unwrap();
        assert_eq!(collection.contacts.len(), 2);
    }
    #[test]
    fn telephone_column_values_exclude_fax_and_headcounts() {
        let values = phones("03-5321-1111\n常勤5名\nFAX 03-5321-1112");
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].e164, "+81353211111");
    }

    #[test]
    fn telephone_extraction_shares_the_normalizers_character_alphabet() {
        for published in [
            "080ｰ9443-9583",
            "0144₋84₋6925",
            "０２７⁻２８９－３８１５",
            "03﹣1234﹣5678",
            "03\u{00a0}1234\u{2009}5678",
        ] {
            let values = phones(&format!("{published} FAX 03-9999-9999"));
            assert_eq!(values.len(), 1, "{published}");
            assert_eq!(values[0].original, published);
            assert_eq!(
                values[0].e164,
                String::from(phonebook_core::normalize_phone(published).unwrap())
            );
        }
        let values = phones("03-1234-5678 090-1234-5678");
        assert_eq!(values.len(), 2);
        for malformed in ["795614", "00000000000", "028-67-3131"] {
            assert!(phones(malformed).is_empty());
        }
    }
    #[test]
    fn no_phone_column_is_not_a_valid_import_header() {
        let values = ["ID", "正式名称", "所在地"].map(String::from);
        assert!(header(&values).is_none());
    }

    #[test]
    fn merged_headers_import_only_the_telephone_band() {
        let row = [
            "",
            "医療機関番号",
            "",
            "医療機関名称",
            "",
            "所在地",
            "",
            "電話番号",
            "",
            "開設者",
        ]
        .map(String::from);
        let layout = header(&row).unwrap();
        assert_eq!(layout.code, (1, 3));
        assert_eq!(layout.phone, (7, 9));
        let values = [
            "",
            "01,1005,6",
            "",
            "Test clinic",
            "",
            "Test address",
            "",
            "",
            "03-5321-1111",
            "Excluded owner",
        ]
        .map(String::from);
        assert_eq!(field(&values, layout.phone), "03-5321-1111");
    }

    #[test]
    fn compact_workbook_uses_declared_columns_and_accounts_for_missing_phones() {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, contents) in [
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "[Content_Types].xml",
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="東京都" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>コード内容別医療機関一覧表</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>令和 8年10月 1日現在 医科</t></is></c></row><row r="3"><c r="B3" t="inlineStr"><is><t>01-1005-6</t></is></c><c r="C3" t="inlineStr"><is><t>Test clinic</t></is></c><c r="D3" t="inlineStr"><is><t>東京都新宿区</t></is></c><c r="E3" t="inlineStr"><is><t>03-5321-1111</t></is></c><c r="F3" t="inlineStr"><is><t>Excluded owner</t></is></c></row><row r="4"><c r="B4" t="inlineStr"><is><t>01-1006-7</t></is></c><c r="C4" t="inlineStr"><is><t>Missing phone clinic</t></is></c></row></sheetData></worksheet>"#,
            ),
        ] {
            archive
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(contents.as_bytes()).unwrap();
        }
        let bytes = archive.finish().unwrap().into_inner();
        calamine::Xlsx::new(Cursor::new(&bytes)).expect("synthetic XLSX fixture");
        let provider = Provider {
            id: "test".into(),
            url: "https://example.com/".into(),
            prefectures: vec![13],
            downloads: 1,
            compact_layout: true,
        };
        let mut collection = Collection {
            contacts: BTreeMap::new(),
            prefectures: vec![Prefecture {
                code: "13".into(),
                name: "東京都".into(),
            }],
            municipalities: Vec::new(),
            reports: Vec::new(),
        };
        let mut source = SourceReport::default();
        workbook(
            bytes,
            "test.xlsx",
            Some(Category::Medical),
            &provider,
            &mut source,
            &mut collection,
        )
        .unwrap();
        assert_eq!(
            (
                source.rows,
                source.accepted,
                source.missing_phone,
                source.invalid
            ),
            (2, 1, 1, 0)
        );
        let contact = collection.contacts.values().next().unwrap();
        assert_eq!(contact.id, "medical:13:medical:0110056");
        assert_eq!(contact.data_as_of, "2026-10-01");
        assert!(
            !serde_json::to_string(contact)
                .unwrap()
                .contains("Excluded owner")
        );
    }

    #[test]
    fn corrupted_cache_is_rejected_without_replacing_a_previous_database() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("phonebook.sqlite"),
            b"previous snapshot",
        )
        .unwrap();
        let fetcher = Fetcher::new(&directory.path().join("raw"), false).unwrap();
        let url = "https://example.com/snapshot";
        let key = format!("{:x}", Sha256::digest(url.as_bytes()));
        fs::write(
            fetcher.cache.join(format!("{key}.json")),
            serde_json::to_vec(&Artifact {
                url: url.into(),
                sha256: "wrong".into(),
                retrieved_at: "fixed".into(),
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(fetcher.cache.join(format!("{key}.bin")), b"corrupted").unwrap();
        assert!(fetcher.get(url, false).is_err());
        assert_eq!(
            fs::read(directory.path().join("phonebook.sqlite")).unwrap(),
            b"previous snapshot"
        );
    }
}
