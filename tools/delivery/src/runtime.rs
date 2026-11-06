use crate::{
    model::{Digest, Operation, PlanRecord, REPOSITORY, Revision},
    repository::{completed, validate_plan},
};
use anyhow::{Context, Result, bail, ensure};
use delivery_core::{Facts, ProviderOutcome, admission};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const BRANCH: &str = "main";
const RUN_LIMIT: &str = "100";
const NONCE_BYTES: usize = 32;
const FIELDS: &str = "databaseId,displayTitle,headSha,headBranch,status,conclusion,url,event";
const REQUEST_FORMAT: u32 = 1;
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

pub fn read_plan(root: &Path, path: &Path) -> Result<PlanRecord> {
    let record: PlanRecord = read_json(path)?;
    validate_plan(root, &record)?;
    Ok(record)
}

pub trait Github {
    fn read(&mut self, arguments: &[String]) -> Result<String>;
    fn dispatch(&mut self, arguments: &[String]) -> Result<()>;
    fn plan(&mut self, _run: u64) -> Result<PlanRecord> {
        bail!("The provider has no candidate plan receipt")
    }
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
    fn plan(&mut self, run: u64) -> Result<PlanRecord> {
        let directory = tempfile::tempdir()?;
        let mut command = Command::new("gh");
        command
            .args([
                "run",
                "download",
                &run.to_string(),
                "--repo",
                REPOSITORY,
                "--name",
                "delivery-plan",
                "--dir",
            ])
            .arg(directory.path());
        completed(command)?;
        read_json(&directory.path().join("plan.json"))
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Intent {
    pub format: u32,
    pub plan: PlanRecord,
    pub operation: Operation,
    pub request: Digest,
    pub controller_revision: Revision,
    pub run: Option<u64>,
}

impl Intent {
    pub fn title(&self) -> String {
        format!("Delivery {} {}", self.operation.name(), self.request)
    }
    pub fn arguments(&self) -> Vec<String> {
        let mut args = vec![
            "workflow".to_owned(),
            "run".to_owned(),
            self.operation.workflow().to_owned(),
            "--repo".to_owned(),
            REPOSITORY.to_owned(),
            "--ref".to_owned(),
            BRANCH.to_owned(),
        ];
        for (name, value) in [
            ("operation", self.operation.name().to_owned()),
            ("source", self.plan.plan.source.to_string()),
            (
                "base",
                self.plan
                    .plan
                    .base
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_default(),
            ),
            (
                "dataset",
                self.plan
                    .plan
                    .dataset
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_default(),
            ),
            ("request", self.request.to_string()),
            ("controller", self.controller_revision.to_string()),
            ("plan", self.plan.sha256.to_string()),
            (
                "targets",
                self.plan
                    .plan
                    .requested
                    .as_ref()
                    .map(|targets| {
                        targets
                            .iter()
                            .map(|target| target.name())
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_default(),
            ),
        ] {
            args.push("-f".to_owned());
            args.push(format!("{name}={value}"));
        }
        args
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Run {
    pub database_id: u64,
    pub display_title: String,
    pub head_sha: Revision,
    pub head_branch: String,
    pub status: String,
    pub conclusion: String,
    pub url: String,
    pub event: String,
}

fn validate_run(intent: &Intent, run: &Run) -> Result<()> {
    ensure!(
        run.database_id > 0
            && run.display_title == intent.title()
            && run.head_sha == intent.controller_revision
            && run.head_branch == BRANCH
            && run.event == "workflow_dispatch"
            && run.url
                == format!(
                    "{}/{REPOSITORY}/actions/runs/{}",
                    crate::model::GITHUB_ORIGIN,
                    run.database_id
                ),
        "The workflow result belongs to another delivery request or controller"
    );
    ensure!(
        [
            "queued",
            "in_progress",
            "completed",
            "waiting",
            "pending",
            "requested"
        ]
        .contains(&run.status.as_str()),
        "Unknown workflow run state"
    );
    ensure!(
        [
            "",
            "success",
            "failure",
            "cancelled",
            "skipped",
            "timed_out",
            "action_required",
            "neutral",
            "stale",
            "startup_failure"
        ]
        .contains(&run.conclusion.as_str()),
        "Unknown workflow conclusion"
    );
    Ok(())
}

fn find_run(github: &mut impl Github, intent: &Intent) -> Result<Option<Run>> {
    if let Some(run) = intent.run {
        let body = github.read(&[
            "run".to_owned(),
            "view".to_owned(),
            run.to_string(),
            "--repo".to_owned(),
            REPOSITORY.to_owned(),
            "--json".to_owned(),
            FIELDS.to_owned(),
        ])?;
        let result = serde_json::from_str(&body)?;
        validate_run(intent, &result)?;
        return Ok(Some(result));
    }
    let body = github.read(&[
        "run".to_owned(),
        "list".to_owned(),
        "--repo".to_owned(),
        REPOSITORY.to_owned(),
        "--workflow".to_owned(),
        intent.operation.workflow().to_owned(),
        "--branch".to_owned(),
        BRANCH.to_owned(),
        "--event".to_owned(),
        "workflow_dispatch".to_owned(),
        "--limit".to_owned(),
        RUN_LIMIT.to_owned(),
        "--json".to_owned(),
        FIELDS.to_owned(),
    ])?;
    let runs: Vec<Run> = serde_json::from_str(&body)?;
    let mut matches = runs
        .into_iter()
        .filter(|run| run.display_title == intent.title());
    let found = matches.next();
    ensure!(
        matches.next().is_none(),
        "More than one workflow run claims this delivery request; reconcile before continuing"
    );
    if let Some(run) = &found {
        validate_run(intent, run)?;
    }
    Ok(found)
}

pub fn status(github: &mut impl Github, intent: &Intent) -> Result<Value> {
    ensure!(
        intent.format == REQUEST_FORMAT,
        "Unsupported delivery request format"
    );
    intent.plan.validate_digest()?;
    ensure!(
        intent.plan.plan.source == intent.controller_revision
            && !intent.plan.plan.selection_required
            && intent
                .plan
                .plan
                .targets
                .contains(&intent.operation.target()),
        "The saved request has an inconsistent source or target identity"
    );
    let run = find_run(github, intent)?;
    if let Some(run) = &run {
        let path = github.read(&[
            "api".to_owned(),
            "--method".to_owned(),
            "GET".to_owned(),
            format!("repos/{REPOSITORY}/actions/runs/{}", run.database_id),
            "--jq".to_owned(),
            ".path".to_owned(),
        ])?;
        ensure!(
            path.trim() == format!(".github/workflows/{}", intent.operation.workflow()),
            "The run belongs to another controller workflow"
        );
    }
    let provider = if run
        .as_ref()
        .is_some_and(|run| run.status == "completed" && run.conclusion == "success")
    {
        let run = run.as_ref().context("Missing completed run")?;
        ensure!(
            github.plan(run.database_id)? == intent.plan,
            "The completed workflow verified another delivery plan"
        );
        ProviderOutcome::AcceptedMatch
    } else {
        ProviderOutcome::Unknown
    };
    let decision = admission(Facts {
        requested: true,
        candidate_matches: true,
        checks_passed: provider == ProviderOutcome::AcceptedMatch,
        approved: provider == ProviderOutcome::AcceptedMatch,
        provider,
    });
    Ok(
        json!({"request":intent.request,"source":intent.plan.plan.source,"operation":intent.operation,"state":format!("{decision:?}"),"run":run,"retry":"Reconcile the recorded request; dispatch never resubmits an existing request."}),
    )
}

pub fn fetch_android(root: &Path, github: &mut impl Github, intent: &Intent) -> Result<PathBuf> {
    let parent = root.join("target/android");
    let destination = parent.join("candidate");
    ensure!(
        !destination.exists(),
        "Preserve the existing Android candidate before fetching another one"
    );
    ensure!(
        intent.operation == Operation::AndroidArtifacts
            && crate::repository::revision(root, "HEAD")? == intent.plan.plan.source,
        "Android artifacts require the matching candidate checkout"
    );
    let result = status(github, intent)?;
    ensure!(
        result["state"] == "Completed",
        "Reconcile the unfinished candidate before downloading artifacts"
    );
    let run = result["run"]["databaseId"]
        .as_u64()
        .context("Missing candidate run")?;
    fs::create_dir_all(&parent)?;
    let directory = tempfile::tempdir_in(&parent)?;
    github.download_android(run, directory.path())?;
    ensure!(
        fs::read_dir(directory.path())?.count() == ANDROID_CANDIDATE_FILES.len(),
        "Unexpected candidate file inventory"
    );
    for name in ANDROID_CANDIDATE_FILES {
        let path = directory.path().join(name);
        ensure!(
            fs::symlink_metadata(&path)?.file_type().is_file(),
            "Candidate artifacts must be ordinary files"
        );
        github.attest_android(&path, &intent.plan.plan.source, &intent.controller_revision)?;
    }
    fs::rename(directory.path(), &destination)?;
    println!("Verified Android candidate provenance from run {run}");
    Ok(destination)
}

fn controller_revision(github: &mut impl Github, source: &Revision) -> Result<Revision> {
    let controller = github.read(&[
        "api".to_owned(),
        "--method".to_owned(),
        "GET".to_owned(),
        format!("repos/{REPOSITORY}/commits/{BRANCH}"),
        "--jq".to_owned(),
        ".sha".to_owned(),
    ])?;
    let controller = Revision::try_from(controller.trim().to_owned())?;
    ensure!(
        source == &controller,
        "Delivery source must match current protected main; prepare a fresh plan after main changes"
    );
    Ok(controller)
}

pub fn request_path(root: &Path, plan: &PlanRecord, operation: Operation) -> PathBuf {
    root.join("target/delivery/requests")
        .join(format!("{}-{}.json", plan.sha256, operation.name()))
}

pub fn dispatch(
    root: &Path,
    github: &mut impl Github,
    plan: PlanRecord,
    operation: Operation,
    path: &Path,
) -> Result<Value> {
    ensure!(
        !plan.plan.selection_required && plan.plan.targets.contains(&operation.target()),
        "Select this operation's target in the delivery plan before dispatch"
    );
    let parent = path.parent().context("The request path has no parent")?;
    fs::create_dir_all(parent)?;
    let lock = fs::File::create(path.with_extension("lock"))?;
    lock.try_lock()
        .context("Another process owns this delivery request")?;
    if path.exists() {
        let intent: Intent = read_json(path)?;
        ensure!(
            intent.plan == plan && intent.operation == operation,
            "Existing request belongs to another candidate or operation"
        );
        return status(github, &intent);
    }
    validate_plan(root, &plan)?;
    let controller_revision = controller_revision(github, &plan.plan.source)?;
    let mut nonce = [0_u8; NONCE_BYTES];
    getrandom::fill(&mut nonce)
        .map_err(|error| anyhow::anyhow!("Cannot create a delivery request identity: {error}"))?;
    let intent = Intent {
        format: REQUEST_FORMAT,
        plan,
        operation,
        request: Digest::of(&nonce),
        controller_revision,
        run: None,
    };
    write_json(path, &intent)?;
    if let Err(error) = github.dispatch(&intent.arguments()) {
        bail!(
            "Delivery submission has an unknown outcome; reconcile {} before another attempt: {error}",
            path.display()
        );
    }
    Ok(
        json!({"request":intent.request,"source":intent.plan.plan.source,"operation":intent.operation,"state":"Submitted","record":path,"next":"Use delivery status with this request record; a missing run remains unresolved."}),
    )
}

pub fn dataset_from_status(body: &str) -> Result<Digest> {
    let records = body
        .lines()
        .filter(|line| line.starts_with('{'))
        .map(serde_json::from_str::<Value>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let [record] = records.as_slice() else {
        bail!("Expected one publication status record");
    };
    ensure!(
        record["operation"] == "publication.status" && record["environment"] == "production",
        "Dataset selection requires production publication status"
    );
    let active = record["deployed"]["current"]["versionId"]
        .as_str()
        .context("The active Worker has no identity")?;
    let journal = record["journal"]
        .as_object()
        .context("No controlled publication baseline exists; specify the dataset digest")?;
    let matching: Vec<_> = ["candidate", "previous"]
        .into_iter()
        .filter_map(|key| journal.get(key))
        .filter(|target| target["versionId"] == active)
        .collect();
    let [target] = matching.as_slice() else {
        bail!("The active Worker doesn't have one unambiguous recorded dataset");
    };
    Digest::try_from(
        target["manifestSha256"]
            .as_str()
            .context("The active Worker has no dataset digest")?
            .to_owned(),
    )
}

pub fn resolve_dataset(value: Option<Digest>) -> Result<Digest> {
    if let Some(digest) = value {
        return Ok(digest);
    }
    let mut command = Command::new("doppler");
    command.args([
        "run",
        "--project",
        "public-phonebook",
        "--config",
        "ci_observe",
        "--only-secrets",
        "CLOUDFLARE_ACCOUNT_ID",
        "--only-secrets",
        "CLOUDFLARE_API_TOKEN",
        "--only-secrets",
        "R2_ACCESS_KEY_ID",
        "--only-secrets",
        "R2_SECRET_ACCESS_KEY",
        "--no-fallback",
        "--",
        "node",
        "tools/publish.ts",
        "production",
        "--status",
    ]);
    let Output { stdout, .. } = completed(command)?;
    dataset_from_status(&String::from_utf8(stdout)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    const ACTIVE: &str = "active-worker";
    #[test]
    fn dataset_selection_follows_the_active_worker_during_a_staged_release() -> Result<()> {
        let old = "a".repeat(64);
        let new = "b".repeat(64);
        let body = json!({"operation":"publication.status","environment":"production","deployed":{"current":{"versionId":ACTIVE}},"journal":{"phase":"staged","candidate":{"versionId":"candidate-worker","manifestSha256":new},"previous":{"versionId":ACTIVE,"manifestSha256":old}}});
        assert_eq!(dataset_from_status(&body.to_string())?.as_str(), old);
        let mut missing = body.clone();
        missing["deployed"]["current"]["versionId"] = json!("untracked");
        assert!(dataset_from_status(&missing.to_string()).is_err());
        let mut ambiguous = body.clone();
        ambiguous["journal"]["candidate"]["versionId"] = json!(ACTIVE);
        assert!(dataset_from_status(&ambiguous.to_string()).is_err());
        let mut preview = body;
        preview["environment"] = json!("preview");
        assert!(dataset_from_status(&preview.to_string()).is_err());
        Ok(())
    }
}
