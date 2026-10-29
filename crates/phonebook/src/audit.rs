use crate::{import::now, model::*, store};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Debug, Serialize)]
pub struct Audit {
    pub checked_at: String,
    pub total_contacts: usize,
    pub unique_phone_numbers: usize,
    pub prefectures: usize,
    pub categories: BTreeMap<String, usize>,
    pub source_rows: usize,
    pub missing_phone: usize,
    pub invalid_rows: usize,
    pub duplicate_rows: usize,
    pub municipality_unassigned: usize,
    pub prefectural_homepage_unconfirmed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<SnapshotComparison>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SnapshotComparison {
    pub baseline_contacts: usize,
    pub added_contacts: usize,
    pub removed_contacts: usize,
    pub changed_contacts: usize,
}

pub fn compare_snapshot(database: &Path, baseline: &Path) -> Result<SnapshotComparison> {
    let baseline = baseline.canonicalize()?;
    let previous = store::open(&baseline)?;
    let version: i64 = previous.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    ensure!(version == 1, "Unsupported baseline schema");
    let integrity: String = previous.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    ensure!(integrity == "ok", "Baseline integrity check failed");
    let connection = store::open(database)?;
    connection.execute(
        "ATTACH DATABASE ?1 AS previous",
        [baseline.to_str().context("Baseline path is not UTF-8")?],
    )?;
    let count = |sql: &str| -> Result<usize> {
        Ok(usize::try_from(
            connection.query_row(sql, [], |row| row.get::<_, i64>(0))?,
        )?)
    };
    Ok(SnapshotComparison {
        baseline_contacts: count("SELECT count(*) FROM previous.contacts")?,
        added_contacts: count(
            "SELECT count(*) FROM contacts c LEFT JOIN previous.contacts p ON c.id=p.id WHERE p.id IS NULL",
        )?,
        removed_contacts: count(
            "SELECT count(*) FROM previous.contacts p LEFT JOIN contacts c ON c.id=p.id WHERE c.id IS NULL",
        )?,
        changed_contacts: count(
            "SELECT count(*) FROM contacts c JOIN previous.contacts p ON c.id=p.id WHERE c.payload != p.payload",
        )?,
    })
}

pub fn verify_preserving(directory: &Path, baseline: &Path) -> Result<Audit> {
    let mut audit = verify(directory)?;
    let comparison = compare_snapshot(&directory.join("phonebook.sqlite"), baseline)?;
    ensure!(
        comparison.removed_contacts == 0 && comparison.changed_contacts == 0,
        "Snapshot preservation failed: {} removed, {} changed",
        comparison.removed_contacts,
        comparison.changed_contacts
    );
    audit.baseline = Some(comparison);
    Ok(audit)
}

pub fn verify(directory: &Path) -> Result<Audit> {
    let database = directory.join("phonebook.sqlite");
    let coverage = store::load_coverage(&database)?;
    ensure!(
        coverage.complete && coverage.prefectures_covered == PREFECTURE_COUNT,
        "Incomplete national coverage"
    );
    let connection = store::open(&database)?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    ensure!(integrity == "ok", "SQLite integrity check failed");
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    ensure!(version == 1, "Unsupported database schema");
    let missing: i64 = connection.query_row("SELECT count(*) FROM contacts c, json_each(c.payload,'$.phones') p LEFT JOIN phones x ON x.contact_id=c.id AND x.number=json_extract(p.value,'$.e164') WHERE x.contact_id IS NULL", [], |row| row.get(0))?;
    let extra: i64 = connection.query_row("SELECT count(*) FROM phones x WHERE NOT EXISTS (SELECT 1 FROM contacts c, json_each(c.payload,'$.phones') p WHERE c.id=x.contact_id AND json_extract(p.value,'$.e164')=x.number)", [], |row| row.get(0))?;
    ensure!(
        missing == 0 && extra == 0,
        "Telephone index mapping mismatch"
    );
    let mut audit = Audit {
        checked_at: now()?,
        total_contacts: 0,
        unique_phone_numbers: 0,
        prefectures: 0,
        categories: BTreeMap::new(),
        source_rows: 0,
        missing_phone: 0,
        invalid_rows: 0,
        duplicate_rows: 0,
        municipality_unassigned: 0,
        prefectural_homepage_unconfirmed: Vec::new(),
        baseline: None,
    };
    let mut cells = BTreeMap::new();
    let mut sources = BTreeMap::new();
    let mut statement = connection.prepare("SELECT payload FROM contacts ORDER BY id")?;
    for payload in statement.query_map([], |row| row.get::<_, String>(0))? {
        let c: Contact = serde_json::from_str(&payload?)?;
        ensure!(
            !c.name.is_empty() && !c.phones.is_empty(),
            "Empty contact {}",
            c.id
        );
        ensure!(
            c.prefecture_code
                .parse::<usize>()
                .is_ok_and(|code| (1..=PREFECTURE_COUNT).contains(&code)),
            "Invalid prefecture {}",
            c.id
        );
        for p in &c.phones {
            ensure!(
                phonebook_core::normalize_phone(&p.original).as_deref() == Ok(p.e164.as_str()),
                "Phone normalization mismatch {}",
                c.id
            );
        }
        if let Some(code) = &c.municipality_code {
            ensure!(
                code.starts_with(&c.prefecture_code),
                "Municipality outside prefecture {}",
                c.id
            );
        } else if c.category != Category::PrefecturalOffice {
            audit.municipality_unassigned += 1;
        }
        if c.category == Category::PrefecturalOffice && !c.official_phone_observed {
            audit.prefectural_homepage_unconfirmed.push(c.id.clone());
        }
        *cells
            .entry((c.prefecture_code, c.category))
            .or_insert(0usize) += 1;
        *sources.entry(c.source_id).or_insert(0usize) += 1;
        *audit.categories.entry(c.category.key().into()).or_default() += 1;
        audit.total_contacts += 1;
    }
    ensure!(
        audit.total_contacts == coverage.total_contacts,
        "Contact count mismatch"
    );
    ensure!(
        coverage.cells.len() == PREFECTURE_COUNT * Category::ALL.len(),
        "Coverage cell inventory mismatch"
    );
    for cell in &coverage.cells {
        ensure!(
            cells
                .get(&(cell.prefecture_code.clone(), cell.category))
                .copied()
                .unwrap_or(0)
                == cell.contacts
                && (!cell.category.nationwide_required() || cell.contacts > 0),
            "Coverage cell mismatch"
        );
    }
    for s in &coverage.sources {
        ensure!(
            s.rows == s.accepted + s.invalid + s.missing_phone + s.duplicate,
            "Source count mismatch {}",
            s.id
        );
        ensure!(
            sources.remove(&s.id).unwrap_or(0) == s.accepted,
            "Accepted source count mismatch {}",
            s.id
        );
        for (url, expected) in [
            (&s.url, &s.sha256),
            (&s.index_url, &s.index_sha256),
            (&s.license_url, &s.license_sha256),
        ]
        .into_iter()
        .chain(s.artifacts.iter().map(|a| (&a.url, &a.sha256)))
        {
            if url.is_empty() && expected.is_empty() {
                continue;
            }
            let bytes = fs::read(
                directory
                    .join("raw/objects")
                    .join(format!("{expected}.bin")),
            )?;
            ensure!(
                format!("{:x}", Sha256::digest(bytes)) == *expected,
                "Raw source hash mismatch {}",
                s.id
            );
        }
        audit.source_rows += s.rows;
        audit.missing_phone += s.missing_phone;
        audit.invalid_rows += s.invalid;
        audit.duplicate_rows += s.duplicate;
    }
    ensure!(sources.is_empty(), "Unknown source identities");
    let numbers: i64 =
        connection.query_row("SELECT count(DISTINCT number) FROM phones", [], |row| {
            row.get(0)
        })?;
    audit.unique_phone_numbers = usize::try_from(numbers)?;
    ensure!(
        audit.unique_phone_numbers == coverage.unique_phone_numbers,
        "Phone index count mismatch"
    );
    let prefectures: i64 = connection.query_row(
        "SELECT count(DISTINCT prefecture) FROM contacts",
        [],
        |row| row.get(0),
    )?;
    audit.prefectures = usize::try_from(prefectures)?;
    ensure!(
        audit.prefectures == PREFECTURE_COUNT,
        "Prefecture count mismatch"
    );
    Ok(audit)
}
