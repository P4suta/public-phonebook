mod support;

use anyhow::{Result, bail};
use delivery::{
    model::Revision,
    repository::revision,
    runtime::{self, Github},
};
use serde_json::{Value, json};
use std::{fs, path::Path};
use support::Repository;

struct Provider {
    run: Value,
    files: Vec<String>,
    bad_attestation: bool,
    attestations: usize,
}

impl Github for Provider {
    fn read(&mut self, arguments: &[String]) -> Result<String> {
        assert_eq!(
            arguments,
            ["api", "repos/P4suta/public-phonebook/actions/runs/42"]
        );
        Ok(self.run.to_string())
    }

    fn dispatch(&mut self, _: &[String]) -> Result<()> {
        bail!("Artifact retrieval cannot dispatch a workflow")
    }

    fn download_android(&mut self, run: u64, directory: &Path) -> Result<()> {
        assert_eq!(run, 42);
        for file in &self.files {
            fs::write(directory.join(file), file)?;
        }
        Ok(())
    }

    fn attest_android(&mut self, _: &Path, source: &Revision, controller: &Revision) -> Result<()> {
        assert_eq!(Some(source.as_str()), self.run["head_sha"].as_str());
        assert_eq!(source, controller);
        self.attestations += 1;
        if self.bad_attestation {
            bail!("Invalid provenance")
        }
        Ok(())
    }
}

fn provider(repo: &Repository) -> Result<Provider> {
    Ok(Provider {
        run: json!({
            "id": 42,
            "head_sha": revision(&repo.root, "HEAD")?,
            "head_branch": "main",
            "status": "completed",
            "conclusion": "success",
            "event": "workflow_dispatch",
            "path": ".github/workflows/android.yml"
        }),
        files: [
            "unsigned.apk",
            "unsigned.aab",
            "sbom.cdx.json",
            "manifest.json",
        ]
        .map(str::to_owned)
        .to_vec(),
        bad_attestation: false,
        attestations: 0,
    })
}

#[test]
fn artifact_retrieval_requires_the_successful_matching_native_workflow() -> Result<()> {
    let repo = Repository::new()?;
    for (field, value) in [
        ("id", json!(43)),
        ("head_sha", json!("a".repeat(40))),
        ("head_branch", json!("feature")),
        ("status", json!("in_progress")),
        ("conclusion", json!("failure")),
        ("event", json!("pull_request")),
        ("path", json!(".github/workflows/ios.yml")),
    ] {
        let mut provider = provider(&repo)?;
        provider.run[field] = value;
        assert!(runtime::fetch_android(&repo.root, &mut provider, 42).is_err());
        assert!(!repo.root.join("target/android/candidate").exists());
    }
    Ok(())
}

#[test]
fn every_artifact_is_verified_before_installation_and_existing_bytes_are_preserved() -> Result<()> {
    let repo = Repository::new()?;
    for fault in ["missing", "extra", "attestation"] {
        let mut provider = provider(&repo)?;
        match fault {
            "missing" => {
                provider.files.pop();
            }
            "extra" => provider.files.push("unexpected.apk".to_owned()),
            _ => provider.bad_attestation = true,
        }
        assert!(runtime::fetch_android(&repo.root, &mut provider, 42).is_err());
        assert!(!repo.root.join("target/android/candidate").exists());
    }
    let mut provider = provider(&repo)?;
    let destination = runtime::fetch_android(&repo.root, &mut provider, 42)?;
    assert_eq!(provider.attestations, 4);
    assert_eq!(
        fs::read_to_string(destination.join("unsigned.apk"))?,
        "unsigned.apk"
    );
    assert!(runtime::fetch_android(&repo.root, &mut provider, 42).is_err());
    assert_eq!(fs::read_dir(destination)?.count(), 4);
    Ok(())
}
