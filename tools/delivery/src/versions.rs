use crate::{
    model::{REPOSITORY, Revision},
    repository::{completed, current_version, require_repository, revision},
    runtime::{Github, read_json, write_json},
};
use anyhow::{Context, Result, ensure};
use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeSet, path::Path, process::Command};

const MAXIMUM_COMMITS: usize = 5000;
const PROPOSAL_LIMIT: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum App {
    Ios,
    Android,
}
impl App {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Ios => "ios",
            Self::Android => "android",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VersionCommit {
    pub sha: Revision,
    pub include: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VersionRequest {
    pub format: u32,
    pub app: App,
    pub source: Revision,
    pub baseline: Revision,
    pub version: String,
    pub commits: Vec<VersionCommit>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Proposal {
    number: u64,
    head_ref_name: String,
    merged_sha: Revision,
    labels: Vec<String>,
}

pub fn version_input(app: App, path: &str) -> Result<bool> {
    let classification = crate::repository::classify(path)?;
    let own = path.starts_with(&format!("apps/{}/", app.name()));
    let other = match app {
        App::Ios => ["tools/android-check/", "verification/android/"],
        App::Android => ["tools/ios-check/", "verification/ios/"],
    };
    Ok(delivery_core::version_needed(
        classification,
        own,
        other.iter().any(|prefix| path.starts_with(prefix)),
    ))
}

fn git(root: &Path, arguments: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command.current_dir(root).args(arguments);
    Ok(String::from_utf8(completed(command)?.stdout)?)
}

pub fn request(root: &Path, app: App) -> Result<VersionRequest> {
    require_repository(root)?;
    ensure!(
        git(root, &["status", "--porcelain"])?.is_empty(),
        "Version proposals require a clean committed source"
    );
    let source = revision(root, "HEAD")?;
    let version = current_version(root, app.name())?.to_string();
    let baseline = Revision::try_from(
        git(
            root,
            &[
                "log",
                "-1",
                "--format=%H",
                source.as_str(),
                "--",
                &format!("apps/{}/version.txt", app.name()),
            ],
        )?
        .trim()
        .to_owned(),
    )?;
    let manifest: Value = read_json(&root.join(format!("releases/{}/manifest.json", app.name())))?;
    ensure!(
        manifest["."] == version,
        "The version proposal manifest differs from the app version"
    );
    let commits = git(
        root,
        &["rev-list", "--reverse", &format!("{baseline}..{source}")],
    )?;
    let mut selected = Vec::new();
    for sha in commits.lines() {
        ensure!(
            selected.len() < MAXIMUM_COMMITS,
            "Version history exceeds the declared commit bound"
        );
        let sha = Revision::try_from(sha.to_owned())?;
        let paths = git(
            root,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-only",
                "--no-renames",
                "-r",
                "-m",
                "--first-parent",
                "-z",
                sha.as_str(),
            ],
        )?;
        let mut include = false;
        for path in paths.split('\0').filter(|path| !path.is_empty()) {
            include |= version_input(app, path)?;
        }
        selected.push(VersionCommit { sha, include });
    }
    Ok(VersionRequest {
        format: 1,
        app,
        source,
        baseline,
        version,
        commits: selected,
    })
}

pub fn prepare(root: &Path, github: &mut impl Github, app: App) -> Result<()> {
    let request = request(root, app)?;
    let head = github.read(&[
        "api".to_owned(),
        "--method".to_owned(),
        "GET".to_owned(),
        format!("repos/{REPOSITORY}/commits/main"),
        "--jq".to_owned(),
        ".sha".to_owned(),
    ])?;
    ensure!(
        head.trim() == request.source.as_str(),
        "Version preparation requires current protected main"
    );
    let pending = format!("version:{}:pending", app.name());
    let body = github.read(&[
        "pr".to_owned(),
        "list".to_owned(),
        "--repo".to_owned(),
        REPOSITORY.to_owned(),
        "--base".to_owned(),
        "main".to_owned(),
        "--state".to_owned(),
        "merged".to_owned(),
        "--label".to_owned(),
        pending.clone(),
        "--limit".to_owned(),
        PROPOSAL_LIMIT.to_string(),
        "--json".to_owned(),
        "number,headRefName,mergeCommit,labels".to_owned(),
        "--jq".to_owned(),
        "[.[] | {number,headRefName,mergedSha:.mergeCommit.oid,labels:[.labels[].name]}]"
            .to_owned(),
    ])?;
    let proposals: Vec<Proposal> = serde_json::from_str(&body)?;
    ensure!(
        proposals.len() < PROPOSAL_LIMIT,
        "Pending version preparations exceed the declared search bound; reconcile their labels before continuing"
    );
    let merged = format!("version:{}:merged", app.name());
    let branch = format!("release-please--branches--main--components--{}", app.name());
    let mut numbers = BTreeSet::new();
    for proposal in &proposals {
        ensure!(
            proposal.number > 0 && numbers.insert(proposal.number),
            "Invalid or duplicate version proposal"
        );
        if !proposal.labels.contains(&pending) {
            continue;
        }
        ensure!(
            proposal.head_ref_name == branch,
            "A pending version label belongs to an unexpected branch"
        );
        git(
            root,
            &[
                "merge-base",
                "--is-ancestor",
                proposal.merged_sha.as_str(),
                request.baseline.as_str(),
            ],
        )
        .context("A merged version proposal isn't included in the committed version baseline")?;
    }
    for proposal in proposals
        .iter()
        .filter(|proposal| proposal.labels.contains(&pending))
    {
        github.dispatch(&[
            "pr".to_owned(),
            "edit".to_owned(),
            proposal.number.to_string(),
            "--repo".to_owned(),
            REPOSITORY.to_owned(),
            "--remove-label".to_owned(),
            pending.clone(),
            "--add-label".to_owned(),
            merged.clone(),
        ])?;
    }
    write_json(&root.join("target/delivery/version-request.json"), &request)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn app_version_inputs_keep_web_presentation_and_server_publication_independent() -> Result<()> {
        for app in [App::Ios, App::Android] {
            assert!(!version_input(app, "apps/web/src/ui/search.css")?);
            assert!(!version_input(app, "wrangler.jsonc")?);
            assert!(!version_input(app, "apps/web/src/server/datasets.ts")?);
            assert!(version_input(
                app,
                "packages/directory/src/kanji-variants.ts"
            )?);
            assert!(version_input(
                app,
                "apps/ios/Sources/PhonebookKit/PlaceReadings.json"
            )?);
            assert!(version_input(
                app,
                "apps/ios/Tests/PhonebookKitTests/PlaceReadingContract.json"
            )?);
            assert!(version_input(app, "unclassified/generator.rs")?);
        }
        assert!(version_input(App::Ios, "apps/ios/App/Main.swift")?);
        assert!(!version_input(App::Android, "apps/ios/App/Main.swift")?);
        assert!(version_input(App::Android, "apps/android/app/src/Main.kt")?);
        assert!(!version_input(App::Ios, "apps/android/app/src/Main.kt")?);
        Ok(())
    }
}
