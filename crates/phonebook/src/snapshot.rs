use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    path::Path,
};

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema: u8,
    pub sha256: String,
    pub contacts: usize,
    pub unique_phone_numbers: usize,
    pub sources: usize,
    pub generated_at: String,
}

pub fn prepare(directory: &Path, output: &Path) -> Result<Manifest> {
    ensure!(!output.exists(), "Service output already exists");
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let _lock = crate::import::lock(directory, false)?;
    crate::audit::verify(directory)?;
    let temporary = tempfile::Builder::new()
        .prefix(".phonebook-service-")
        .tempdir_in(parent)?;
    let database = temporary.path().join("phonebook.sqlite");
    fs::copy(directory.join("phonebook.sqlite"), &database)?;
    crate::store::index_names(&database)?;
    let comparison =
        crate::audit::compare_snapshot(&database, &directory.join("phonebook.sqlite"))?;
    ensure!(
        comparison.added_contacts == 0
            && comparison.removed_contacts == 0
            && comparison.changed_contacts == 0,
        "Service preparation changed contact records"
    );
    let coverage = crate::store::load_coverage(&database)?;
    let manifest = Manifest {
        schema: 1,
        sha256: digest(&database)?,
        contacts: coverage.total_contacts,
        unique_phone_numbers: coverage.unique_phone_numbers,
        sources: coverage.sources.len(),
        generated_at: coverage.generated_at,
    };
    fs::write(
        temporary.path().join("snapshot.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    File::create(temporary.path().join("directory.lock"))?;
    ensure!(!output.exists(), "Service output already exists");
    fs::rename(temporary.path(), output).context("Publish the prepared local service directory")?;
    Ok(manifest)
}

pub fn verify_manifest(
    database: &Path,
    coverage: &crate::model::Coverage,
    sha256: &str,
) -> Result<()> {
    let path = database
        .parent()
        .context("Database parent missing")?
        .join("snapshot.json");
    if !path.try_exists()? {
        return Ok(());
    }
    let manifest: Manifest = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(
        manifest.schema == 1
            && manifest.sha256 == sha256
            && manifest.contacts == coverage.total_contacts
            && manifest.unique_phone_numbers == coverage.unique_phone_numbers
            && manifest.sources == coverage.sources.len()
            && manifest.generated_at == coverage.generated_at,
        "Service snapshot identity does not match its manifest"
    );
    Ok(())
}

pub fn digest(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 64 * 1024];
    loop {
        let length = file.read(&mut bytes)?;
        if length == 0 {
            break;
        }
        hash.update(&bytes[..length]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
