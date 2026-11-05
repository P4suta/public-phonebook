//! Admits the directory archive that each app build bundles, from the dataset that a reviewed declaration names.
//!
//! The build never resolves the current listing.
//! It reads the ready manifest of the declared release, takes its `directory.tsv.br` entry, and admits the archive with the app's own checks.

use super::logged;
use crate::locations::{CURL, PRODUCTION_ORIGIN};
use anyhow::{Context, Result, bail, ensure};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// The national dataset that production and verification configurations bundle.
pub(super) const NATIONAL: &str = "ios/bundled-dataset.json";
/// The provider fixture that development configurations bundle.
pub(super) const FIXTURE: &str = "ios/bundled-fixture.json";
/// The admitted pairs, one directory for each value of `PHONEBOOK_BUNDLED_DATASET`.
const OUTPUT: &str = "target/ios/bundled-dataset";
/// Holds each national dataset under its ready manifest's SHA-256, as `just data-fetch MANIFEST DIRECTORY` writes it.
const CACHE: &str = "target/datasets";
const ADMISSION_SCRATCH: &str = "target/ios/bundled-admission";
const RELEASES: &str = "https://github.com/P4suta/public-phonebook/releases/download";
pub(super) const ARCHIVE_FILE: &str = "directory.tsv.br";
pub(super) const ENTRY_FILE: &str = "directory.json";
const SEARCH_FILES: [&str; 3] = ["search-index.br", "search-ranking.br", "search.json"];
const MANIFEST_FILE: &str = "manifest.ready.json";
const FORMAT: &str = "public-phonebook-directory/1";
const MAXIMUM_MANIFEST_BYTES: u64 = 1_048_576;
/// The archive header's limit on `generatedAt`, which `ArchiveHeader.validated` applies.
const MAXIMUM_GENERATED_AT_BYTES: usize = 128;
/// The leading hexadecimal digits of a snapshot that a passing line names.
const REPORTED_SNAPSHOT_DIGITS: usize = 8;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NationalDeclaration {
    release: String,
    manifest_sha256: String,
    snapshot: String,
    contacts: u64,
    bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FixtureDeclaration {
    corpus: String,
    revision: String,
    snapshot: String,
    contacts: u64,
    bytes: u64,
    sha256: String,
}

/// The fields that a declaration repeats for review, which the manifest and the archive must equal.
#[derive(Clone, Debug, PartialEq)]
struct Declared {
    snapshot: String,
    contacts: u64,
    bytes: u64,
    sha256: String,
}

/// The manifest's description of the archive, which becomes the entry beside it in the app.
#[derive(Clone, Debug, PartialEq)]
struct Entry {
    snapshot: String,
    generated_at: String,
    contacts: u64,
    bytes: u64,
    sha256: String,
}

impl Entry {
    fn json(&self) -> Value {
        json!({
            "snapshot": self.snapshot, "generatedAt": self.generated_at, "contacts": self.contacts,
            "format": FORMAT, "bytes": self.bytes, "sha256": self.sha256,
        })
    }
}

/// The configuration family that bundles each dataset, which names its output directory.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Dataset {
    National,
    Fixture,
}

impl Dataset {
    pub(super) fn of(configuration: &str) -> Self {
        if matches!(configuration, "Debug" | "DevRelease") {
            Self::Fixture
        } else {
            Self::National
        }
    }

    /// The value of `PHONEBOOK_BUNDLED_DATASET`.
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::National => "national",
            Self::Fixture => "fixture",
        }
    }

    fn declaration(self) -> &'static str {
        match self {
            Self::National => NATIONAL,
            Self::Fixture => FIXTURE,
        }
    }
}

fn differs(
    declaration: &str,
    field: &str,
    declared: impl ToString,
    found: impl ToString,
) -> String {
    format!(
        "{declaration}: the bundled dataset differs in {field}: declared {}, found {}",
        declared.to_string(),
        found.to_string()
    )
}

fn hex64(value: &str) -> bool {
    value.len() == super::SHA256_HEX_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Takes the archive entry from a ready manifest or a listing, and names the first field that differs from the declaration.
fn select_entry(
    declaration: &str,
    manifest: &[u8],
    manifest_sha256: Option<&str>,
    declared: &Declared,
) -> Result<Entry> {
    if let Some(expected) = manifest_sha256 {
        let found = crate::sha256_hex(manifest);
        ensure!(
            found == expected,
            differs(declaration, "manifestSha256", expected, found)
        );
    }
    let manifest: Value = serde_json::from_slice(manifest)
        .with_context(|| format!("{declaration}: the ready manifest is not JSON"))?;
    let snapshot = manifest["snapshot"].as_str().unwrap_or_default();
    ensure!(
        snapshot == declared.snapshot,
        differs(declaration, "snapshot", &declared.snapshot, snapshot)
    );
    let contacts = manifest["contacts"].as_u64().unwrap_or_default();
    ensure!(
        contacts == declared.contacts,
        differs(declaration, "contacts", declared.contacts, contacts)
    );
    let generated_at = manifest["generatedAt"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= MAXIMUM_GENERATED_AT_BYTES)
        .with_context(|| format!("{declaration}: the ready manifest has no generatedAt"))?;
    let archives = manifest["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|file| file["file"] == ARCHIVE_FILE)
        .collect::<Vec<_>>();
    let [file] = archives.as_slice() else {
        bail!(
            "{declaration}: the ready manifest lists {} {ARCHIVE_FILE} entries instead of one",
            archives.len()
        );
    };
    if let Some(format) = file.get("format") {
        ensure!(
            format == FORMAT,
            differs(declaration, "format", FORMAT, format)
        );
    }
    let sha256 = file["sha256"].as_str().unwrap_or_default();
    ensure!(
        sha256 == declared.sha256,
        differs(declaration, "sha256", &declared.sha256, sha256)
    );
    let bytes = file["bytes"].as_u64().unwrap_or_default();
    ensure!(
        bytes == declared.bytes,
        differs(declaration, "bytes", declared.bytes, bytes)
    );
    let url = format!("/api/datasets/{snapshot}/{sha256}/{ARCHIVE_FILE}");
    ensure!(
        file["url"] == url.as_str(),
        differs(declaration, "url", url, &file["url"])
    );
    Ok(Entry {
        snapshot: snapshot.to_owned(),
        generated_at: generated_at.to_owned(),
        contacts,
        bytes,
        sha256: sha256.to_owned(),
    })
}

/// Requires the archive's length and SHA-256 to equal the declaration, and names the one that differs.
fn admit_bytes(declaration: &str, archive: &[u8], declared: &Declared) -> Result<()> {
    let bytes = archive.len() as u64;
    ensure!(
        bytes == declared.bytes,
        differs(declaration, "bytes", declared.bytes, bytes)
    );
    let sha256 = crate::sha256_hex(archive);
    ensure!(
        sha256 == declared.sha256,
        differs(declaration, "sha256", &declared.sha256, sha256)
    );
    Ok(())
}

fn read_declaration<T: for<'de> Deserialize<'de>>(root: &Path, path: &str) -> Result<T> {
    serde_json::from_slice(&fs::read(root.join(path)).with_context(|| format!("Read {path}"))?)
        .with_context(|| format!("{path} is not a bundled dataset declaration"))
}

/// Downloads a public immutable file over HTTPS without credentials, keeping at most `limit` bytes.
pub(super) fn download(root: &Path, url: &str, destination: &Path, limit: u64) -> Result<()> {
    let partial = destination.with_extension("partial");
    let result = logged(
        root,
        "bundled-download",
        super::without_secrets(&mut Command::new(CURL))
            .args([
                "--fail",
                "--silent",
                "--show-error",
                "--location",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "--retry",
                "2",
                "--max-filesize",
                &limit.to_string(),
                "--output",
            ])
            .arg(&partial)
            .arg(url),
    );
    if let Err(error) = result {
        let error = error.context(format!("Download {url}"));
        return Err(match fs::remove_file(&partial) {
            Err(cleanup) if cleanup.kind() != std::io::ErrorKind::NotFound => {
                error.context(format!(
                    "Remove the partial download {}: {cleanup}",
                    partial.display()
                ))
            }
            _ => error,
        });
    }
    fs::rename(&partial, destination)?;
    Ok(())
}

/// One declared dataset with the manifest that describes it and the archive bytes that passed its length and SHA-256.
struct Source {
    declared: Declared,
    manifest: Vec<u8>,
    manifest_sha256: Option<String>,
    entry: Entry,
    archive: Vec<u8>,
}

/// Reads the declared release's manifest and archive from the cache, filling it from the public URLs when a file is missing.
fn national(root: &Path) -> Result<Source> {
    let declaration: NationalDeclaration = read_declaration(root, NATIONAL)?;
    ensure!(
        hex64(&declaration.manifest_sha256)
            && hex64(&declaration.snapshot)
            && hex64(&declaration.sha256),
        "{NATIONAL}: every digest is 64 lowercase hexadecimal digits"
    );
    ensure!(
        !declaration.release.is_empty()
            && declaration
                .release
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.'),
        "{NATIONAL}: the release names one tag"
    );
    let declared = Declared {
        snapshot: declaration.snapshot,
        contacts: declaration.contacts,
        bytes: declaration.bytes,
        sha256: declaration.sha256,
    };
    let cache = root.join(CACHE).join(&declaration.manifest_sha256);
    fs::create_dir_all(&cache)?;
    let manifest_path = cache.join(MANIFEST_FILE);
    if !manifest_path.is_file() {
        download(
            root,
            &format!("{RELEASES}/{}/{MANIFEST_FILE}", declaration.release),
            &manifest_path,
            MAXIMUM_MANIFEST_BYTES,
        )?;
    }
    let manifest = fs::read(&manifest_path)?;
    let entry = select_entry(
        NATIONAL,
        &manifest,
        Some(&declaration.manifest_sha256),
        &declared,
    )?;
    let archive_path = cache.join(ARCHIVE_FILE);
    if !archive_path.is_file() {
        download(
            root,
            &format!(
                "{PRODUCTION_ORIGIN}/api/datasets/{}/{}/{ARCHIVE_FILE}",
                entry.snapshot, entry.sha256
            ),
            &archive_path,
            declared.bytes,
        )?;
    }
    let archive = fs::read(&archive_path)?;
    admit_bytes(NATIONAL, &archive, &declared)?;
    Ok(Source {
        declared,
        manifest,
        manifest_sha256: Some(declaration.manifest_sha256),
        entry,
        archive,
    })
}

#[derive(Deserialize)]
struct CorpusResponse {
    revision: String,
    path: String,
    body: String,
    encoding: Option<String>,
}

/// Reads the fixture's listing and archive from the provider corpus that the package tests replay.
fn fixture(root: &Path) -> Result<Source> {
    let declaration: FixtureDeclaration = read_declaration(root, FIXTURE)?;
    let declared = Declared {
        snapshot: declaration.snapshot,
        contacts: declaration.contacts,
        bytes: declaration.bytes,
        sha256: declaration.sha256,
    };
    let corpus: Vec<CorpusResponse> = serde_json::from_slice(
        &fs::read(root.join(&declaration.corpus))
            .with_context(|| format!("Read {}", declaration.corpus))?,
    )?;
    let response = |path: &str| {
        corpus
            .iter()
            .find(|entry| entry.revision == declaration.revision && entry.path == path)
            .with_context(|| format!("{FIXTURE}: the corpus has no {path}"))
    };
    let listing = response("/api/datasets")?;
    let entry = select_entry(FIXTURE, listing.body.as_bytes(), None, &declared)?;
    let archive = response(&format!(
        "/api/datasets/{}/{}/{ARCHIVE_FILE}",
        entry.snapshot, entry.sha256
    ))?;
    ensure!(
        archive.encoding.as_deref() == Some("base64"),
        "{FIXTURE}: the corpus archive is not base64"
    );
    let archive = base64::engine::general_purpose::STANDARD.decode(&archive.body)?;
    admit_bytes(FIXTURE, &archive, &declared)?;
    Ok(Source {
        declared,
        manifest: listing.body.clone().into_bytes(),
        manifest_sha256: None,
        entry,
        archive,
    })
}

/// Whether `directory` already holds this archive and an entry with these values.
fn current(directory: &Path, entry: &Entry) -> bool {
    let Ok(archive) = fs::read(directory.join(ARCHIVE_FILE)) else {
        return false;
    };
    let Ok(written) = fs::read(directory.join(ENTRY_FILE)) else {
        return false;
    };
    crate::sha256_hex(&archive) == entry.sha256
        && archive.len() as u64 == entry.bytes
        && serde_json::from_slice::<Value>(&written).is_ok_and(|value| value == entry.json())
}

/// Admits one archive with the app's own checks and installs it with its entry, unless the output already holds both.
fn install(root: &Path, dataset: Dataset, entry: &Entry, archive: &[u8]) -> Result<()> {
    let directory = root.join(OUTPUT).join(dataset.name());
    if current(&directory, entry) {
        println!(
            "PASS: {} bundles snapshot {} already admitted",
            dataset.name(),
            &entry.snapshot[..REPORTED_SNAPSHOT_DIGITS]
        );
        return Ok(());
    }
    let scratch = root.join(ADMISSION_SCRATCH).join(dataset.name());
    if scratch.exists() {
        fs::remove_dir_all(&scratch)?;
    }
    fs::create_dir_all(&scratch)?;
    let candidate = scratch.join(ARCHIVE_FILE);
    let expected = scratch.join("expected.json");
    let admitted = scratch.join(ENTRY_FILE);
    fs::write(&candidate, archive)?;
    fs::write(&expected, serde_json::to_vec(&entry.json())?)?;
    logged(
        root,
        &format!("bundled-admission-{}", dataset.name()),
        Command::new("xcrun")
            .current_dir(root)
            .args([
                "swift",
                "run",
                "--package-path",
                "ios",
                "--configuration",
                "release",
                "--jobs",
                "2",
                "BundledAdmission",
            ])
            .arg(&candidate)
            .arg(&expected)
            .arg(&admitted),
    )
    .with_context(|| {
        format!(
            "{}: the app's own checks refused the bundled archive",
            dataset.declaration()
        )
    })?;
    let written: Value = serde_json::from_slice(&fs::read(&admitted)?)?;
    ensure!(
        written == entry.json(),
        "{}: the admission wrote an entry other than the manifest's",
        dataset.declaration()
    );
    fs::create_dir_all(&directory)?;
    fs::rename(&candidate, directory.join(ARCHIVE_FILE))?;
    fs::rename(&admitted, directory.join(ENTRY_FILE))?;
    fs::remove_dir_all(&scratch)?;
    println!(
        "PASS: {} bundles snapshot {}, {} bytes, admitted with the app's checks",
        dataset.name(),
        &entry.snapshot[..REPORTED_SNAPSHOT_DIGITS],
        entry.bytes
    );
    Ok(())
}

/// Requires one changed archive byte and one changed declaration field to fail and name their field.
fn require_controls(dataset: Dataset, source: &Source) -> Result<()> {
    let declaration = dataset.declaration();
    let mut changed = source.archive.clone();
    let middle = changed.len() / 2;
    changed[middle] ^= 1;
    ensure!(
        admit_bytes(declaration, &changed, &source.declared)
            .is_err_and(|error| error.to_string().contains("differs in sha256")),
        "{declaration}: the admission accepted an archive with one changed byte"
    );
    let control = Declared {
        contacts: source.declared.contacts + 1,
        ..source.declared.clone()
    };
    ensure!(
        select_entry(
            declaration,
            &source.manifest,
            source.manifest_sha256.as_deref(),
            &control
        )
        .is_err_and(|error| error.to_string().contains("differs in contacts")),
        "{declaration}: the admission accepted a declaration with a changed row count"
    );
    Ok(())
}

/// Admits the national and fixture archives into the directories that the app target copies from.
pub(super) fn prepare(root: &Path) -> Result<()> {
    for dataset in [Dataset::National, Dataset::Fixture] {
        let source = match dataset {
            Dataset::National => national(root)?,
            Dataset::Fixture => fixture(root)?,
        };
        require_controls(dataset, &source)?;
        install(root, dataset, &source.entry, &source.archive)?;
        prepare_search(root, dataset, &source.entry)?;
        compare_search_forms(root, dataset)?;
    }
    Ok(())
}

fn search_files(manifest: &Value, files: &[(&str, &[u8])]) -> Result<()> {
    ensure!(
        manifest["format"] == "public-phonebook-bundled-search/1",
        "Unsupported bundled search format"
    );
    for (kind, bytes) in files {
        let entry = &manifest[*kind];
        ensure!(
            entry["bytes"].as_u64() == Some(bytes.len() as u64),
            "Search {kind} length mismatch"
        );
        ensure!(
            entry["sha256"].as_str() == Some(crate::sha256_hex(bytes).as_str()),
            "Search {kind} digest mismatch"
        );
    }
    Ok(())
}

fn prepare_search(root: &Path, dataset: Dataset, archive: &Entry) -> Result<()> {
    let (manifest, index, ranking) = match dataset {
        Dataset::National => (
            serde_json::from_slice::<Value>(&fs::read(root.join("ios/SearchData/national.json"))?)?,
            fs::read(root.join("ios/SearchData/search-index.br"))?,
            fs::read(root.join("ios/SearchData/search-ranking.br"))?,
        ),
        Dataset::Fixture => {
            let declaration: FixtureDeclaration = read_declaration(root, FIXTURE)?;
            let corpus: Vec<CorpusResponse> =
                serde_json::from_slice(&fs::read(root.join(declaration.corpus))?)?;
            let response = |path: &str| -> Result<&CorpusResponse> {
                corpus
                    .iter()
                    .find(|entry| entry.revision == declaration.revision && entry.path == path)
                    .with_context(|| format!("The provider corpus has no {path}"))
            };
            let index: Value = serde_json::from_str(&response("/api/search-index")?.body)?;
            let ranking: Value = serde_json::from_str(&response("/api/search-ranking")?.body)?;
            ensure!(
                index["snapshot"] == archive.snapshot && ranking["snapshot"] == archive.snapshot,
                "Fixture search snapshot mismatch"
            );
            let bytes = |entry: &Value| -> Result<Vec<u8>> {
                let url = entry["url"]
                    .as_str()
                    .context("Search artifact has no URL")?;
                let response = response(&format!("{url}/download"))?;
                ensure!(
                    response.encoding.as_deref() == Some("base64"),
                    "Search artifact isn't base64"
                );
                Ok(base64::engine::general_purpose::STANDARD.decode(&response.body)?)
            };
            let index_bytes = bytes(&index)?;
            let ranking_bytes = bytes(&ranking)?;
            (
                json!({"format":"public-phonebook-bundled-search/1", "snapshot":archive.snapshot, "contacts":archive.contacts, "index":index, "ranking":ranking}),
                index_bytes,
                ranking_bytes,
            )
        }
    };
    ensure!(
        manifest["snapshot"] == archive.snapshot && manifest["contacts"] == archive.contacts,
        "The bundled search artifacts differ from the archive"
    );
    search_files(&manifest, &[("index", &index), ("ranking", &ranking)])?;
    let scratch = root
        .join(ADMISSION_SCRATCH)
        .join(format!("search-{}", dataset.name()));
    fs::create_dir_all(&scratch)?;
    fs::write(scratch.join("search-index.br"), &index)?;
    fs::write(scratch.join("search-ranking.br"), &ranking)?;
    fs::write(
        scratch.join("search.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    logged(
        root,
        &format!("bundled-search-{}", dataset.name()),
        Command::new("xcrun")
            .current_dir(root)
            .args([
                "swift",
                "run",
                "--package-path",
                "ios",
                "--configuration",
                "release",
                "--jobs",
                "2",
                "BundledAdmission",
                "--search-bundle",
            ])
            .arg(&scratch)
            .arg(&archive.snapshot)
            .arg(archive.contacts.to_string()),
    )?;
    let output = root.join(OUTPUT).join(dataset.name());
    for name in SEARCH_FILES {
        fs::rename(scratch.join(name), output.join(name))?;
    }
    fs::remove_dir(&scratch)?;
    Ok(())
}

/// Requires the app's comparison form of every bundled name to equal the website's, on every run, because either folding can change while the archive stays.
fn compare_search_forms(root: &Path, dataset: Dataset) -> Result<()> {
    let archive = root.join(OUTPUT).join(dataset.name()).join(ARCHIVE_FILE);
    let scratch = root.join(ADMISSION_SCRATCH);
    fs::create_dir_all(&scratch)?;
    let forms = scratch.join(format!("search-forms-{}.tsv", dataset.name()));
    logged(
        root,
        &format!("search-forms-{}", dataset.name()),
        Command::new("node")
            .current_dir(root)
            .arg("tools/search-form-parity.ts")
            .arg(&archive)
            .arg(&forms),
    )?;
    let compared = logged(
        root,
        &format!("search-form-parity-{}", dataset.name()),
        Command::new("xcrun")
            .current_dir(root)
            .args([
                "swift",
                "run",
                "--package-path",
                "ios",
                "--configuration",
                "release",
                "--jobs",
                "2",
                "BundledAdmission",
                "--search-forms",
            ])
            .arg(&forms),
    )
    .with_context(|| {
        format!(
            "{}: the app folds a name differently from the website",
            dataset.declaration()
        )
    })?;
    fs::remove_file(&forms)?;
    print!("{}", String::from_utf8_lossy(&compared.stdout));
    Ok(())
}

fn bundle_files(app: &Path) -> Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    let mut pending = vec![app.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for item in fs::read_dir(&directory)? {
            let path = item?.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.file_name().is_some_and(|name| {
                name == ARCHIVE_FILE
                    || name == ENTRY_FILE
                    || SEARCH_FILES.iter().any(|search| name == *search)
            }) {
                found.push(path);
            }
        }
    }
    found.sort();
    Ok(found)
}

/// Requires the built app to hold the admitted archive and entry of its configuration, and the extension to hold neither.
fn require_built(
    declaration: &str,
    app: &Path,
    declared: &Declared,
    archive: &[u8],
    entry: &[u8],
    admitted_entry: &[u8],
) -> Result<()> {
    admit_bytes(declaration, archive, declared)?;
    let entry: Value = serde_json::from_slice(entry)?;
    let admitted: Value = serde_json::from_slice(admitted_entry)?;
    ensure!(
        entry == admitted,
        "{declaration}: the built app's entry differs from the admitted entry"
    );
    let files = bundle_files(app)?;
    let mut expected = vec![app.join(ENTRY_FILE), app.join(ARCHIVE_FILE)];
    expected.extend(SEARCH_FILES.map(|name| app.join(name)));
    expected.sort();
    ensure!(
        files == expected,
        "{declaration}: the built app holds bundled dataset files outside its resources: {files:?}"
    );
    Ok(())
}

/// Compares one built app with its declaration, and requires the comparison to refuse one changed byte.
pub(super) fn check_built(root: &Path, app: &Path, configuration: &str) -> Result<()> {
    let dataset = Dataset::of(configuration);
    let declaration = dataset.declaration();
    let declared = match dataset {
        Dataset::National => {
            let value: NationalDeclaration = read_declaration(root, NATIONAL)?;
            Declared {
                snapshot: value.snapshot,
                contacts: value.contacts,
                bytes: value.bytes,
                sha256: value.sha256,
            }
        }
        Dataset::Fixture => {
            let value: FixtureDeclaration = read_declaration(root, FIXTURE)?;
            Declared {
                snapshot: value.snapshot,
                contacts: value.contacts,
                bytes: value.bytes,
                sha256: value.sha256,
            }
        }
    };
    let archive = fs::read(app.join(ARCHIVE_FILE))
        .with_context(|| format!("{configuration}: the built app holds no {ARCHIVE_FILE}"))?;
    let entry = fs::read(app.join(ENTRY_FILE))
        .with_context(|| format!("{configuration}: the built app holds no {ENTRY_FILE}"))?;
    let admitted = fs::read(root.join(OUTPUT).join(dataset.name()).join(ENTRY_FILE))?;
    require_built(declaration, app, &declared, &archive, &entry, &admitted)?;
    let prepared = root.join(OUTPUT).join(dataset.name());
    for name in SEARCH_FILES {
        ensure!(
            fs::read(app.join(name))? == fs::read(prepared.join(name))?,
            "{configuration}: built search artifact {name} differs from admission"
        );
    }
    let mut changed = archive.clone();
    let last = changed.len() - 1;
    changed[last] ^= 1;
    ensure!(
        require_built(declaration, app, &declared, &changed, &entry, &admitted)
            .is_err_and(|error| error.to_string().contains("differs in sha256")),
        "{configuration}: the built-app check accepted an archive with one changed byte"
    );
    println!(
        "PASS: {configuration} bundles {} bytes of snapshot {} beside its entry, the extension carries none, and a changed byte fails",
        declared.bytes,
        &declared.snapshot[..REPORTED_SNAPSHOT_DIGITS]
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declared() -> Declared {
        Declared {
            snapshot: "a".repeat(64),
            contacts: 2,
            bytes: 3,
            sha256: crate::sha256_hex(b"abc"),
        }
    }

    fn manifest(declared: &Declared) -> Value {
        json!({
            "snapshot": declared.snapshot, "generatedAt": "2026-10-30T00:00:00Z", "contacts": declared.contacts,
            "files": [
                {"file": "contacts.csv.gz", "sha256": "b".repeat(64), "bytes": 9, "url": "/x"},
                {"file": ARCHIVE_FILE, "sha256": declared.sha256, "bytes": declared.bytes,
                    "url": format!("/api/datasets/{}/{}/{ARCHIVE_FILE}", declared.snapshot, declared.sha256)},
            ],
        })
    }

    #[test]
    fn manifest_entry_matches_the_declaration() -> Result<()> {
        let declared = declared();
        let bytes = serde_json::to_vec(&manifest(&declared))?;
        let entry = select_entry("d", &bytes, Some(&crate::sha256_hex(&bytes)), &declared)?;
        assert_eq!(entry.generated_at, "2026-10-30T00:00:00Z");
        assert_eq!(entry.json()["format"], FORMAT);
        admit_bytes("d", b"abc", &declared)?;
        require_controls(
            Dataset::National,
            &Source {
                declared: declared.clone(),
                manifest_sha256: Some(crate::sha256_hex(&bytes)),
                manifest: bytes,
                entry,
                archive: b"abc".to_vec(),
            },
        )
    }

    #[test]
    fn each_differing_field_is_named() -> Result<()> {
        let declared = declared();
        let bytes = serde_json::to_vec(&manifest(&declared))?;
        let named = |result: Result<Entry>, field: &str| {
            result.is_err_and(|error| error.to_string().contains(&format!("differs in {field}")))
        };
        assert!(named(
            select_entry("d", &bytes, Some(&"0".repeat(64)), &declared),
            "manifestSha256"
        ));
        for (field, value) in [("snapshot", json!("c".repeat(64))), ("contacts", json!(3))] {
            let mut changed = manifest(&declared);
            changed[field] = value;
            assert!(
                named(
                    select_entry("d", &serde_json::to_vec(&changed)?, None, &declared),
                    field
                ),
                "{field}"
            );
        }
        for (field, value) in [
            ("sha256", json!("c".repeat(64))),
            ("bytes", json!(4)),
            ("url", json!("/elsewhere")),
            ("format", json!("public-phonebook-directory/2")),
        ] {
            let mut changed = manifest(&declared);
            changed["files"][1][field] = value;
            assert!(
                named(
                    select_entry("d", &serde_json::to_vec(&changed)?, None, &declared),
                    field
                ),
                "{field}"
            );
        }
        let mut doubled = manifest(&declared);
        let archive = doubled["files"][1].clone();
        doubled["files"]
            .as_array_mut()
            .context("files")?
            .push(archive);
        assert!(select_entry("d", &serde_json::to_vec(&doubled)?, None, &declared).is_err());
        assert!(
            admit_bytes("d", b"abd", &declared)
                .is_err_and(|error| error.to_string().contains("differs in sha256"))
        );
        assert!(
            admit_bytes("d", b"abcd", &declared)
                .is_err_and(|error| error.to_string().contains("differs in bytes"))
        );
        Ok(())
    }

    #[test]
    fn configurations_pick_their_dataset() {
        for configuration in ["Debug", "DevRelease"] {
            assert_eq!(Dataset::of(configuration), Dataset::Fixture);
        }
        for configuration in [
            "VerificationDebug",
            "VerificationRelease",
            "ProductionDebug",
            "Release",
        ] {
            assert_eq!(Dataset::of(configuration), Dataset::National);
        }
    }

    #[test]
    fn built_app_check_refuses_extra_copies_and_changed_entries() -> Result<()> {
        let declared = declared();
        let app = tempfile::tempdir()?;
        let entry = serde_json::to_vec(&json!({"snapshot": declared.snapshot}))?;
        fs::write(app.path().join(ARCHIVE_FILE), b"abc")?;
        fs::write(app.path().join(ENTRY_FILE), &entry)?;
        for name in SEARCH_FILES {
            fs::write(app.path().join(name), b"fixture")?;
        }
        require_built("d", app.path(), &declared, b"abc", &entry, &entry)?;
        assert!(require_built("d", app.path(), &declared, b"abc", &entry, b"{}").is_err());
        let extension = app.path().join("PlugIns/CallDirectory.appex");
        fs::create_dir_all(&extension)?;
        for name in SEARCH_FILES {
            fs::write(extension.join(name), b"fixture")?;
            assert!(require_built("d", app.path(), &declared, b"abc", &entry, &entry).is_err());
            fs::remove_file(extension.join(name))?;
        }
        fs::write(extension.join(ARCHIVE_FILE), b"abc")?;
        assert!(require_built("d", app.path(), &declared, b"abc", &entry, &entry).is_err());
        Ok(())
    }
}
