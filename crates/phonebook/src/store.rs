use crate::model::*;
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, params, params_from_iter};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

const NAME_INDEX: &str = "CREATE INDEX IF NOT EXISTS contact_name ON contacts(name,id);";

pub fn normalized(value: &str) -> String {
    value
        .nfkc()
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .trim()
        .to_owned()
}

pub fn web_url(value: &str) -> Option<String> {
    url::Url::parse(value)
        .ok()
        .filter(|url| {
            matches!(url.scheme(), "https" | "http")
                && url.username().is_empty()
                && url.password().is_none()
        })
        .map(|url| url.to_string())
}

pub fn coverage(
    contacts: &[Contact],
    prefectures: &[Prefecture],
    sources: Vec<SourceReport>,
    generated_at: String,
) -> Coverage {
    let mut counts = BTreeMap::new();
    let mut phones = BTreeSet::new();
    let mut source_counts = BTreeMap::new();
    for contact in contacts {
        *source_counts
            .entry(contact.source_id.as_str())
            .or_insert(0usize) += 1;
        *counts
            .entry((contact.prefecture_code.clone(), contact.category))
            .or_insert(0) += 1;
        for phone in &contact.phones {
            phones.insert(&phone.e164);
        }
    }
    let cells: Vec<_> = prefectures
        .iter()
        .flat_map(|prefecture| {
            Category::ALL.into_iter().map(|category| CoverageCell {
                prefecture_code: prefecture.code.clone(),
                prefecture: prefecture.name.clone(),
                category,
                contacts: counts
                    .get(&(prefecture.code.clone(), category))
                    .copied()
                    .unwrap_or(0),
            })
        })
        .collect();
    let covered = prefectures
        .iter()
        .filter(|p| {
            Category::ALL
                .iter()
                .filter(|c| c.nationwide_required())
                .all(|c| counts.get(&(p.code.clone(), *c)).copied().unwrap_or(0) > 0)
        })
        .count();
    let reconciled = !sources.is_empty()
        && sources
            .iter()
            .map(|source| source.accepted)
            .try_fold(0usize, usize::checked_add)
            == Some(contacts.len())
        && sources.iter().map(|s| &s.id).collect::<BTreeSet<_>>().len() == sources.len()
        && sources.iter().all(|s| {
            !s.id.is_empty()
                && source_counts.get(s.id.as_str()).copied().unwrap_or(0) == s.accepted
                && [s.accepted, s.missing_phone, s.invalid, s.duplicate]
                    .into_iter()
                    .try_fold(0usize, usize::checked_add)
                    == Some(s.rows)
        });
    let inventory = prefectures
        .iter()
        .map(|p| p.code.clone())
        .collect::<BTreeSet<_>>()
        == (1..=PREFECTURE_COUNT)
            .map(|code| format!("{code:02}"))
            .collect();
    let well_formed = contacts
        .iter()
        .map(|c| &c.id)
        .collect::<BTreeSet<_>>()
        .len()
        == contacts.len()
        && contacts.iter().all(|c| {
            !c.id.is_empty()
                && !c.name.trim().is_empty()
                && !c.phones.is_empty()
                && prefectures
                    .iter()
                    .any(|p| p.code == c.prefecture_code && p.name == c.prefecture)
                && c.municipality_code.as_ref().is_none_or(|code| {
                    code.len() == MUNICIPALITY_CODE_LENGTH
                        && code.bytes().all(|byte| byte.is_ascii_digit())
                        && code.starts_with(&c.prefecture_code)
                })
                && c.phones.iter().all(|p| {
                    phonebook_core::normalize_phone(&p.original).as_deref() == Ok(p.e164.as_str())
                })
        });
    Coverage {
        generated_at,
        total_contacts: contacts.len(),
        unique_phone_numbers: phones.len(),
        prefectures_covered: covered,
        complete: covered == PREFECTURE_COUNT
            && prefectures.len() == PREFECTURE_COUNT
            && reconciled
            && inventory
            && well_formed,
        cells,
        sources,
    }
}

pub fn build_database(path: &Path, contacts: &[Contact], report: &Coverage) -> Result<()> {
    let prefectures = report
        .cells
        .iter()
        .filter(|cell| cell.category == Category::Medical)
        .map(|cell| Prefecture {
            code: cell.prefecture_code.clone(),
            name: cell.prefecture.clone(),
        })
        .collect::<Vec<_>>();
    let checked = coverage(
        contacts,
        &prefectures,
        report.sources.clone(),
        report.generated_at.clone(),
    );
    ensure!(
        report.complete && checked == *report,
        "National coverage is incomplete: {}/47 prefectures have every category",
        report.prefectures_covered
    );
    let mut connection = Connection::open(path)?;
    connection.execute_batch("PRAGMA journal_mode=DELETE; CREATE TABLE contacts(id TEXT PRIMARY KEY, prefecture TEXT NOT NULL, municipality TEXT, category TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE phones(number TEXT NOT NULL, contact_id TEXT NOT NULL REFERENCES contacts(id), PRIMARY KEY(number,contact_id)); CREATE TABLE metadata(key TEXT PRIMARY KEY, payload TEXT NOT NULL);")?;
    let transaction = connection.transaction()?;
    {
        let mut insert = transaction.prepare("INSERT INTO contacts VALUES(?1,?2,?3,?4,?5,?6)")?;
        let mut phone_insert = transaction.prepare("INSERT INTO phones VALUES(?1,?2)")?;
        for contact in contacts {
            insert.execute(params![
                contact.id,
                contact.prefecture_code,
                contact.municipality_code,
                contact.category.key(),
                normalized(&contact.name),
                serde_json::to_string(contact)?
            ])?;
            for phone in &contact.phones {
                phone_insert.execute(params![phone.e164, contact.id])?;
            }
        }
    }
    transaction.execute(
        "INSERT INTO metadata VALUES('coverage',?1)",
        [serde_json::to_string(report)?],
    )?;
    transaction.execute_batch("CREATE INDEX contact_region ON contacts(prefecture,municipality,category); CREATE INDEX contact_category ON contacts(category); PRAGMA user_version=1;")?;
    transaction.execute_batch(NAME_INDEX)?;
    transaction.commit()?;
    let result: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    ensure!(result == "ok", "Database integrity check failed: {result}");
    Ok(())
}

pub fn stage_snapshot(
    directory: &Path,
    contacts: &[Contact],
    report: &Coverage,
) -> Result<tempfile::NamedTempFile> {
    let staging = tempfile::NamedTempFile::new_in(directory)?;
    build_database(staging.path(), contacts, report)?;
    staging.as_file().sync_all()?;
    Ok(staging)
}

pub fn open(path: &Path) -> Result<Connection> {
    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .context("Run `mise x -- just update-data` before starting the directory")
}

pub(crate) fn index_names(path: &Path) -> Result<()> {
    let connection =
        Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    connection.execute_batch(NAME_INDEX)?;
    Ok(())
}

#[cfg(test)]
mod search_plans {
    use super::*;

    #[test]
    fn name_queries_scan_only_covering_names_and_lookup_matching_payloads() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE contacts(id TEXT PRIMARY KEY, prefecture TEXT, municipality TEXT, category TEXT, name TEXT, payload TEXT); CREATE INDEX contact_name ON contacts(name,id);").unwrap();
        for prefecture in ["", "13"] {
            let (condition, values) = filter(&Search {
                q: "横浜市役所".into(),
                prefecture: prefecture.into(),
                ..Default::default()
            })
            .unwrap();
            for selection in ["count(*)", "payload"] {
                let suffix = if selection == "payload" {
                    " ORDER BY id LIMIT 50"
                } else {
                    ""
                };
                let sql = format!(
                    "EXPLAIN QUERY PLAN SELECT {selection} FROM contacts{condition}{suffix}"
                );
                let details = connection
                    .prepare(&sql)
                    .unwrap()
                    .query_map(params_from_iter(&values), |row| row.get::<_, String>(3))
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap();
                assert!(
                    details
                        .iter()
                        .any(|value| value.contains("COVERING INDEX contact_name")),
                    "{details:?}"
                );
                assert!(
                    !details
                        .iter()
                        .any(|value| value.starts_with("SCAN contacts")
                            && !value.contains("COVERING INDEX")),
                    "{details:?}"
                );
            }
        }
    }
}

pub fn load_coverage(path: &Path) -> Result<Coverage> {
    let value: String = open(path)?.query_row(
        "SELECT payload FROM metadata WHERE key='coverage'",
        [],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&value)?)
}

pub fn municipalities(path: &Path) -> Result<Vec<(String, String)>> {
    let connection = open(path)?;
    let mut statement = connection.prepare("SELECT payload FROM contacts WHERE category='municipal_office' ORDER BY prefecture,municipality")?;
    statement
        .query_map([], |row| row.get::<_, String>(0))?
        .map(|payload| {
            let contact: Contact = serde_json::from_str(&payload?)?;
            Ok((
                contact
                    .municipality_code
                    .context("Municipal office without code")?,
                contact.name,
            ))
        })
        .collect()
}

fn filter(search: &Search) -> Result<(String, Vec<String>)> {
    let search = search.checked()?;
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    let region = match search.region() {
        phonebook_core::Region::All => None,
        phonebook_core::Region::Prefecture(code) => Some((
            "prefecture",
            code.digits()
                .into_iter()
                .map(char::from)
                .collect::<String>(),
        )),
        phonebook_core::Region::Municipality(code) => Some((
            "municipality",
            code.digits().iter().copied().map(char::from).collect(),
        )),
    };
    if let Some((column, value)) = region {
        clauses.push(format!("{column} = ?"));
        values.push(value);
    }
    if let Some(category) = search.category() {
        clauses.push("category = ?".into());
        values.push(category.key().into());
    }
    let query = normalized(search.text());
    if !query.is_empty() {
        if let Ok(number) = phonebook_core::normalize_phone(&query) {
            clauses.push("id IN (SELECT contact_id FROM phones WHERE number = ?)".to_owned());
            values.push(String::from(number));
        } else {
            clauses.push("id IN (SELECT id FROM contacts WHERE instr(name, ?) > 0)".to_owned());
            values.push(query);
        }
    }
    Ok((
        if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        },
        values,
    ))
}

pub fn search(path: &Path, query: &Search, paginate: bool) -> Result<SearchResult> {
    let connection = open(path)?;
    let (condition, values) = filter(query)?;
    let total_raw: i64 = connection.query_row(
        &format!("SELECT count(*) FROM contacts{condition}"),
        params_from_iter(&values),
        |r| r.get(0),
    )?;
    let total = usize::try_from(total_raw).context("Invalid result count")?;
    let window = phonebook_core::PageWindow::new(total, query.page);
    let suffix = if paginate {
        format!(
            " LIMIT {} OFFSET {}",
            phonebook_core::PAGE_SIZE,
            window.offset()
        )
    } else {
        String::new()
    };
    let mut statement = connection.prepare(&format!(
        "SELECT payload FROM contacts{condition} ORDER BY id{suffix}"
    ))?;
    let payloads = statement.query_map(params_from_iter(&values), |row| row.get::<_, String>(0))?;
    let contacts = payloads
        .map(|r| -> Result<Contact> { Ok(serde_json::from_str(&r?)?) })
        .collect::<Result<Vec<_>>>()?;
    Ok(SearchResult {
        total,
        contacts,
        page: window.page(),
        pages: window.pages(),
    })
}

pub fn contact(path: &Path, id: &str) -> Result<Contact> {
    let payload: String =
        open(path)?.query_row("SELECT payload FROM contacts WHERE id=?1", [id], |r| {
            r.get(0)
        })?;
    Ok(serde_json::from_str(&payload)?)
}

pub fn vcard(contact: &Contact) -> String {
    use phonebook_core::{escape_text, fold_line};
    let mut lines = vec![
        "BEGIN:VCARD".to_owned(),
        "VERSION:3.0".to_owned(),
        format!("UID:urn:public-phonebook:{}", escape_text(&contact.id)),
        format!("FN:{}", escape_text(&contact.name)),
        format!("N:{};;;;", escape_text(&contact.name)),
        format!("ORG:{}", escape_text(&contact.name)),
        format!("ADR;TYPE=WORK:;;{};;;;", escape_text(&contact.address)),
    ];
    for phone in &contact.phones {
        lines.push(format!("TEL;TYPE=WORK,VOICE:{}", phone.e164));
    }
    if let Some(url) = contact.official_url.as_deref().and_then(web_url) {
        lines.push(format!("URL:{}", escape_text(&url)));
    }
    let mut note = format!(
        "Source: {} | {} | As of: {} | Retrieved: {} | Adapted by Public Phonebook",
        contact.source_url, contact.license, contact.data_as_of, contact.retrieved_at
    );
    if !contact.category.attribution().is_empty() {
        note.push_str(" | ");
        note.push_str(contact.category.attribution());
    }
    lines.push(format!("NOTE:{}", escape_text(&note)));
    lines.push("END:VCARD".to_owned());
    lines
        .iter()
        .map(|line| String::from(fold_line(line)))
        .collect()
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ExportContact<'a> {
    #[serde(flatten)]
    contact: &'a Contact,
    #[serde(skip_serializing_if = "str::is_empty")]
    attribution: &'static str,
}

impl<'a> From<&'a Contact> for ExportContact<'a> {
    fn from(contact: &'a Contact) -> Self {
        Self {
            contact,
            attribution: contact.category.attribution(),
        }
    }
}

struct CsvText<'a>(std::borrow::Cow<'a, str>);

impl<'a> CsvText<'a> {
    fn cell(value: &'a str) -> Self {
        match phonebook_core::csv_text_boundary(value.chars().next()) {
            phonebook_core::CsvTextBoundary::Literal => Self(std::borrow::Cow::Borrowed(value)),
            phonebook_core::CsvTextBoundary::Quote => {
                Self(std::borrow::Cow::Owned(format!("'{value}")))
            }
        }
    }

    fn canonical_phones(value: &'a str) -> Result<Self> {
        for number in value.split(" | ") {
            ensure!(
                phonebook_core::normalize_phone(number)
                    .is_ok_and(|normalized| &*normalized == number),
                "Invalid canonical phone cell"
            );
        }
        Ok(Self(std::borrow::Cow::Borrowed(value)))
    }
}

impl AsRef<[u8]> for CsvText<'_> {
    fn as_ref(&self) -> &[u8] {
        self.0.as_bytes()
    }
}

pub fn export(contacts: &[Contact], format: &str) -> Result<(Vec<u8>, &'static str)> {
    let format = phonebook_core::ExportFormat::parse(format).context("Choose json, csv, or vcf")?;
    export_as(contacts, format)
}

pub fn export_as(
    contacts: &[Contact],
    format: phonebook_core::ExportFormat,
) -> Result<(Vec<u8>, &'static str)> {
    match format {
        phonebook_core::ExportFormat::Json => Ok((
            serde_json::to_vec_pretty(
                &contacts.iter().map(ExportContact::from).collect::<Vec<_>>(),
            )?,
            format.mime(),
        )),
        phonebook_core::ExportFormat::Vcf => Ok((
            contacts.iter().map(vcard).collect::<String>().into_bytes(),
            format.mime(),
        )),
        phonebook_core::ExportFormat::Csv => {
            let mut writer = csv::Writer::from_writer(Vec::new());
            writer.write_record([
                "id",
                "prefecture_code",
                "prefecture",
                "municipality_code",
                "category",
                "name",
                "address",
                "phone_original",
                "phone_e164",
                "official_url",
                "source_url",
                "license",
                "license_url",
                "data_as_of",
                "retrieved_at",
                "attribution",
            ])?;
            for c in contacts {
                let raw = c
                    .phones
                    .iter()
                    .map(|p| p.original.as_str())
                    .collect::<Vec<_>>()
                    .join(" | ");
                let canonical = c
                    .phones
                    .iter()
                    .map(|p| p.e164.as_str())
                    .collect::<Vec<_>>()
                    .join(" | ");
                let fields = [
                    CsvText::cell(&c.id),
                    CsvText::cell(&c.prefecture_code),
                    CsvText::cell(&c.prefecture),
                    CsvText::cell(c.municipality_code.as_deref().unwrap_or("")),
                    CsvText::cell(c.category.key()),
                    CsvText::cell(&c.name),
                    CsvText::cell(&c.address),
                    CsvText::cell(&raw),
                    CsvText::canonical_phones(&canonical)?,
                    CsvText::cell(c.official_url.as_deref().unwrap_or("")),
                    CsvText::cell(&c.source_url),
                    CsvText::cell(&c.license),
                    CsvText::cell(&c.license_url),
                    CsvText::cell(&c.data_as_of),
                    CsvText::cell(&c.retrieved_at),
                    CsvText::cell(c.category.attribution()),
                ];
                writer.write_record(fields)?;
            }
            Ok((writer.into_inner()?, format.mime()))
        }
    }
}

pub fn write_export(
    path: &Path,
    query: &Search,
    format: &str,
    output: impl Write,
) -> Result<&'static str> {
    let format = phonebook_core::ExportFormat::parse(format).context("Choose json, csv, or vcf")?;
    write_export_as(path, query, format, output)
}

pub fn write_export_as(
    path: &Path,
    query: &Search,
    format: phonebook_core::ExportFormat,
    mut output: impl Write,
) -> Result<&'static str> {
    use phonebook_core::ExportFormat;
    let connection = open(path)?;
    let (condition, values) = filter(query)?;
    let mut statement = connection.prepare(&format!(
        "SELECT payload FROM contacts{condition} ORDER BY id"
    ))?;
    let rows = statement.query_map(params_from_iter(&values), |row| row.get::<_, String>(0))?;
    if format == ExportFormat::Json {
        output.write_all(b"[\n")?;
    }
    let mut first = true;
    if format == ExportFormat::Csv {
        output.write_all(&export_as(&[], format)?.0)?;
    }
    for payload in rows {
        let contact: Contact = serde_json::from_str(&payload?)?;
        match format {
            ExportFormat::Json => {
                if !first {
                    output.write_all(b",\n")?;
                }
                serde_json::to_writer(&mut output, &ExportContact::from(&contact))?;
            }
            ExportFormat::Csv => {
                let (bytes, _) = export_as(&[contact], format)?;
                let offset = bytes
                    .iter()
                    .position(|b| *b == b'\n')
                    .context("CSV header missing")?
                    + 1;
                output.write_all(&bytes[offset..])?;
            }
            ExportFormat::Vcf => output.write_all(vcard(&contact).as_bytes())?,
        }
        first = false;
    }
    if format == ExportFormat::Json {
        output.write_all(b"\n]\n")?;
    }
    Ok(format.mime())
}
