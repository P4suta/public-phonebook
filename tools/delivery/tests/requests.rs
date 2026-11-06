mod support;
use anyhow::{Result, bail};
use delivery::{
    model::{Digest, Operation, Target},
    repository::{plan, revision},
    runtime::{self, Github, Intent},
};
use serde_json::{Value, json};
use std::{collections::VecDeque, fs, path::Path};
use support::Repository;

#[derive(Default)]
struct Provider {
    responses: VecDeque<String>,
    writes: Vec<Vec<String>>,
    lose_response: bool,
    plan: Option<delivery::model::PlanRecord>,
    files: Vec<String>,
    bad_attestation: bool,
    attestations: usize,
}
impl Github for Provider {
    fn download_android(&mut self, _run: u64, directory: &Path) -> Result<()> {
        for name in &self.files {
            fs::write(directory.join(name), name)?;
        }
        Ok(())
    }
    fn attest_android(
        &mut self,
        _path: &Path,
        source: &delivery::model::Revision,
        controller: &delivery::model::Revision,
    ) -> Result<()> {
        assert_eq!(source, controller);
        self.attestations += 1;
        if self.bad_attestation {
            bail!("The artifact has another signer");
        }
        Ok(())
    }
    fn plan(&mut self, _run: u64) -> Result<delivery::model::PlanRecord> {
        self.plan
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Missing plan receipt"))
    }
    fn read(&mut self, _arguments: &[String]) -> Result<String> {
        self.responses
            .pop_front()
            .ok_or_else(|| anyhow::anyhow!("Unexpected provider read"))
    }
    fn dispatch(&mut self, arguments: &[String]) -> Result<()> {
        self.writes.push(arguments.to_vec());
        if self.lose_response {
            bail!("The response disappeared after acceptance");
        }
        Ok(())
    }
}

fn run(intent: &Intent) -> Value {
    json!({"databaseId":42,"displayTitle":intent.title(),"headSha":intent.controller_revision,"headBranch":"main","status":"completed","conclusion":"success","url":"https://github.com/P4suta/public-phonebook/actions/runs/42","event":"workflow_dispatch"})
}

#[test]
fn a_lost_dispatch_response_preserves_identity_and_never_resubmits() -> Result<()> {
    let repo = Repository::new()?;
    let source = revision(&repo.root, "HEAD")?;
    let record = plan(
        &repo.root,
        source.clone(),
        None,
        Some(vec![Target::Android]),
        None,
    )?;
    let path = runtime::request_path(&repo.root, &record, Operation::AndroidArtifacts);
    let mut provider = Provider {
        responses: VecDeque::from([source.to_string()]),
        lose_response: true,
        ..Provider::default()
    };
    assert!(
        runtime::dispatch(
            &repo.root,
            &mut provider,
            record.clone(),
            Operation::AndroidArtifacts,
            &path
        )
        .is_err()
    );
    let intent: Intent = runtime::read_json(&path)?;
    assert_eq!(intent.plan, record);
    assert_eq!(provider.writes.len(), 1);
    assert!(
        provider
            .writes
            .first()
            .is_some_and(|arguments| arguments.iter().any(|argument| argument == "android.yml"))
    );
    provider.responses.push_back("[]".to_owned());
    assert_eq!(
        runtime::dispatch(
            &repo.root,
            &mut provider,
            record.clone(),
            Operation::AndroidArtifacts,
            &path
        )?["state"],
        "Reconcile"
    );
    assert_eq!(provider.writes.len(), 1);
    provider
        .responses
        .push_back(json!([run(&intent)]).to_string());
    provider
        .responses
        .push_back(".github/workflows/android.yml".to_owned());
    provider.plan = Some(record.clone());
    assert_eq!(
        runtime::dispatch(
            &repo.root,
            &mut provider,
            record,
            Operation::AndroidArtifacts,
            &path
        )?["state"],
        "Completed"
    );
    assert_eq!(provider.writes.len(), 1);
    Ok(())
}

#[test]
fn stale_main_or_unselected_targets_cannot_submit() -> Result<()> {
    let repo = Repository::new()?;
    let record = plan(
        &repo.root,
        revision(&repo.root, "HEAD")?,
        None,
        Some(vec![Target::Ios]),
        None,
    )?;
    let path = runtime::request_path(&repo.root, &record, Operation::IosTestflight);
    let mut provider = Provider {
        responses: VecDeque::from(["a".repeat(40)]),
        ..Provider::default()
    };
    assert!(
        runtime::dispatch(
            &repo.root,
            &mut provider,
            record.clone(),
            Operation::IosTestflight,
            &path
        )
        .is_err()
    );
    assert!(provider.writes.is_empty() && !path.exists());
    assert!(
        runtime::dispatch(&repo.root, &mut provider, record, Operation::Worker, &path).is_err()
    );
    assert!(provider.writes.is_empty());
    Ok(())
}

#[test]
fn ambiguous_or_mismatched_runs_cannot_claim_completion() -> Result<()> {
    let repo = Repository::new()?;
    let source = revision(&repo.root, "HEAD")?;
    let intent = Intent {
        format: 1,
        plan: plan(
            &repo.root,
            source.clone(),
            None,
            Some(vec![Target::Ios]),
            None,
        )?,
        operation: Operation::IosTestflight,
        request: Digest::of(b"fixture"),
        controller_revision: source,
        run: None,
    };
    let completed = run(&intent);
    for (property, wrong) in [
        ("headSha", json!("a".repeat(40))),
        ("headBranch", json!("fork")),
        ("event", json!("pull_request")),
        ("url", json!("https://attacker.invalid/run")),
        ("status", json!("invented")),
        ("conclusion", json!("invented")),
    ] {
        let mut value = completed.clone();
        value[property] = wrong;
        let mut provider = Provider {
            responses: VecDeque::from([json!([value]).to_string()]),
            ..Provider::default()
        };
        assert!(runtime::status(&mut provider, &intent).is_err());
        assert!(provider.writes.is_empty());
    }
    let mut duplicate = Provider {
        responses: VecDeque::from([json!([completed.clone(), completed.clone()]).to_string()]),
        ..Provider::default()
    };
    assert!(runtime::status(&mut duplicate, &intent).is_err());
    let mut wrong_workflow = Provider {
        responses: VecDeque::from([
            json!([completed]).to_string(),
            ".github/workflows/attacker.yml".to_owned(),
        ]),
        ..Provider::default()
    };
    assert!(runtime::status(&mut wrong_workflow, &intent).is_err());
    Ok(())
}

fn android_intent(repo: &Repository) -> Result<Intent> {
    let source = revision(&repo.root, "HEAD")?;
    Ok(Intent {
        format: 1,
        plan: plan(
            &repo.root,
            source.clone(),
            None,
            Some(vec![Target::Android]),
            None,
        )?,
        operation: Operation::AndroidArtifacts,
        request: Digest::of(b"android fixture"),
        controller_revision: source,
        run: None,
    })
}

fn completed_provider(intent: &Intent) -> Provider {
    Provider {
        responses: VecDeque::from([
            json!([run(intent)]).to_string(),
            ".github/workflows/android.yml".to_owned(),
        ]),
        plan: Some(intent.plan.clone()),
        files: [
            "unsigned.apk",
            "unsigned.aab",
            "sbom.cdx.json",
            "manifest.json",
        ]
        .map(str::to_owned)
        .to_vec(),
        ..Provider::default()
    }
}

#[test]
fn a_successful_run_requires_its_original_verified_plan() -> Result<()> {
    let repo = Repository::new()?;
    let intent = android_intent(&repo)?;
    let mut provider = completed_provider(&intent);
    let mut body = intent.plan.plan.clone();
    body.versions.android = "9.0.0".to_owned();
    provider.plan = Some(delivery::model::PlanRecord::seal(body)?);
    assert!(runtime::status(&mut provider, &intent).is_err());
    provider = completed_provider(&intent);
    provider.plan = None;
    assert!(runtime::status(&mut provider, &intent).is_err());
    Ok(())
}

#[test]
fn every_android_file_needs_provenance_before_the_candidate_is_installed() -> Result<()> {
    let repo = Repository::new()?;
    let intent = android_intent(&repo)?;
    for fault in ["missing", "extra", "attestation"] {
        let mut provider = completed_provider(&intent);
        match fault {
            "missing" => {
                provider.files.pop();
            }
            "extra" => provider.files.push("unexpected.apk".to_owned()),
            _ => provider.bad_attestation = true,
        }
        assert!(runtime::fetch_android(&repo.root, &mut provider, &intent).is_err());
        assert!(!repo.root.join("target/android/candidate").exists());
    }
    let mut provider = completed_provider(&intent);
    let destination = runtime::fetch_android(&repo.root, &mut provider, &intent)?;
    assert_eq!(provider.attestations, 4);
    assert_eq!(
        fs::read_to_string(destination.join("unsigned.apk"))?,
        "unsigned.apk"
    );
    assert!(runtime::fetch_android(&repo.root, &mut provider, &intent).is_err());
    assert_eq!(fs::read_dir(destination)?.count(), 4);
    Ok(())
}

#[test]
fn failed_or_incomplete_runs_require_reconciliation_without_another_write() -> Result<()> {
    let repo = Repository::new()?;
    let intent = android_intent(&repo)?;
    for conclusion in [
        "failure",
        "cancelled",
        "skipped",
        "timed_out",
        "action_required",
    ] {
        let mut value = run(&intent);
        value["conclusion"] = json!(conclusion);
        let mut provider = Provider {
            responses: VecDeque::from([
                json!([value]).to_string(),
                ".github/workflows/android.yml".to_owned(),
            ]),
            ..Provider::default()
        };
        assert_eq!(
            runtime::status(&mut provider, &intent)?["state"],
            "Reconcile"
        );
        assert!(provider.writes.is_empty());
    }
    Ok(())
}
