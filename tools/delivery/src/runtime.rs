use crate::{
    model::{REPOSITORY, Revision},
    repository::{completed, require_repository, revision},
};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

const ANDROID_CANDIDATE_FILES: [&str; 4] = [
    "unsigned.apk",
    "unsigned.aab",
    "sbom.cdx.json",
    "manifest.json",
];
pub const MAXIMUM_RECORD_BYTES: u64 = 4 * 1024 * 1024;

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    ensure!(
        fs::metadata(path)?.len() <= MAXIMUM_RECORD_BYTES,
        "Oversized delivery record"
    );
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let mut output = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(output.as_file_mut(), value)?;
    output.write_all(b"\n")?;
    output.as_file().sync_all()?;
    output
        .persist(path)
        .context("Cannot save delivery evidence")?;
    Ok(())
}

pub trait Github {
    fn read(&mut self, arguments: &[String]) -> Result<String>;
    fn dispatch(&mut self, arguments: &[String]) -> Result<()>;
    fn download_android(&mut self, _run: u64, _directory: &Path) -> Result<()> {
        bail!("The provider has no Android candidate")
    }
    fn attest_android(
        &mut self,
        _path: &Path,
        _source: &Revision,
        _controller: &Revision,
    ) -> Result<()> {
        bail!("The provider has no Android provenance")
    }
}

pub struct GithubCli;
impl Github for GithubCli {
    fn download_android(&mut self, run: u64, directory: &Path) -> Result<()> {
        let mut command = Command::new("gh");
        command
            .args([
                "run",
                "download",
                &run.to_string(),
                "--repo",
                REPOSITORY,
                "--name",
                "android-unsigned-candidate",
                "--dir",
            ])
            .arg(directory);
        completed(command).map(|_| ())
    }

    fn attest_android(
        &mut self,
        path: &Path,
        source: &Revision,
        controller: &Revision,
    ) -> Result<()> {
        let mut command = Command::new("gh");
        command.args(["attestation", "verify"]).arg(path).args([
            "--repo",
            REPOSITORY,
            "--source-ref",
            "refs/heads/main",
            "--source-digest",
            source.as_str(),
            "--signer-digest",
            controller.as_str(),
            "--signer-workflow",
            &format!("{REPOSITORY}/.github/workflows/android.yml"),
        ]);
        completed(command).map(|_| ())
    }

    fn read(&mut self, arguments: &[String]) -> Result<String> {
        let mut command = Command::new("gh");
        command.args(arguments);
        Ok(String::from_utf8(completed(command)?.stdout)?)
    }

    fn dispatch(&mut self, arguments: &[String]) -> Result<()> {
        let mut command = Command::new("gh");
        command.args(arguments);
        completed(command).map(|_| ())
    }
}

#[derive(Deserialize)]
struct Run {
    id: u64,
    head_sha: Revision,
    head_branch: String,
    status: String,
    conclusion: Option<String>,
    event: String,
    path: String,
}

pub fn fetch_android(root: &Path, github: &mut impl Github, run: u64) -> Result<PathBuf> {
    require_repository(root)?;
    ensure!(run > 0, "A workflow run identifier must be positive");
    let parent = root.join("target/android");
    let destination = parent.join("candidate");
    ensure!(
        !destination.exists(),
        "Preserve the existing Android candidate before fetching another one"
    );
    let source = revision(root, "HEAD")?;
    let observed: Run = serde_json::from_str(&github.read(&[
        "api".to_owned(),
        format!("repos/{REPOSITORY}/actions/runs/{run}"),
    ])?)?;
    ensure!(
        observed.id == run
            && observed.head_sha == source
            && observed.head_branch == "main"
            && observed.status == "completed"
            && observed.conclusion.as_deref() == Some("success")
            && observed.event == "workflow_dispatch"
            && observed.path == ".github/workflows/android.yml",
        "Android artifacts require a successful matching main workflow and candidate checkout"
    );
    fs::create_dir_all(&parent)?;
    let directory = tempfile::tempdir_in(&parent)?;
    github.download_android(run, directory.path())?;
    ensure!(
        fs::read_dir(directory.path())?.count() == ANDROID_CANDIDATE_FILES.len(),
        "Unexpected candidate file inventory"
    );
    for name in ANDROID_CANDIDATE_FILES {
        let path = directory.path().join(name);
        let metadata = fs::symlink_metadata(&path)?;
        ensure!(
            metadata.file_type().is_file() && metadata.len() > 0,
            "Candidate artifacts must be nonempty ordinary files"
        );
        github.attest_android(&path, &source, &source)?;
    }
    fs::rename(directory.path(), &destination)?;
    println!("Verified Android candidate provenance from run {run}");
    Ok(destination)
}
