use crate::model::{
    ChangedInput, Digest, PLAN_FORMAT, PlanBody, PlanRecord, REPOSITORY, Revision, Target,
    Versions, category,
};
use anyhow::{Context, Result, ensure};
use delivery_core::{Change, Impact, Plan, Version, impact};
use std::{
    collections::BTreeSet,
    path::Path,
    process::{Command, Output},
};

pub fn completed(mut command: Command) -> Result<Output> {
    let output = command
        .output()
        .context("Cannot start the delivery command")?;
    ensure!(
        output.status.success(),
        "Delivery command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(output)
}

fn git(root: &Path, arguments: &[&str]) -> Result<Vec<u8>> {
    let mut command = Command::new("git");
    command.current_dir(root).args(arguments);
    Ok(completed(command)?.stdout)
}

pub fn revision(root: &Path, reference: &str) -> Result<Revision> {
    let resolved = git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ],
    )?;
    Revision::try_from(String::from_utf8(resolved)?.trim().to_owned())
}

pub fn require_repository(root: &Path) -> Result<()> {
    let origin = String::from_utf8(git(root, &["remote", "get-url", "origin"])?)?;
    let origin = origin.trim();
    ensure!(
        origin == format!("{}/{REPOSITORY}.git", crate::model::GITHUB_ORIGIN)
            || origin == format!("{}/{REPOSITORY}", crate::model::GITHUB_ORIGIN)
            || origin == format!("git@github.com:{REPOSITORY}.git"),
        "Delivery requires the configured project repository"
    );
    Ok(())
}

fn inside(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

pub fn classify(path: &str) -> Result<Change> {
    ensure!(
        !path.is_empty()
            && !path.starts_with('/')
            && !path.contains('\\')
            && !path.chars().any(char::is_control)
            && path
                .split('/')
                .all(|segment| !segment.is_empty() && segment != "." && segment != ".."),
        "A changed input has an invalid repository path"
    );
    if path == "src/core/kanji-variants.ts" || path == "src/ui/icons.tsx" || inside(path, "design")
    {
        return Ok(Change::SharedSource);
    }
    if inside(path, "src/core") {
        return Ok(Change::SharedSource);
    }
    if inside(path, "src/server")
        || path == "ios/Tests/PhonebookCoreTests/SearchContract.json"
        || path == "ios/Tests/PhonebookKitTests/DirectoryContract.json"
    {
        return Ok(Change::ServerContract);
    }
    if inside(path, "ios") {
        return Ok(Change::Ios);
    }
    if inside(path, "android") {
        return Ok(Change::Android);
    }
    if inside(path, "src/ui")
        || inside(path, "src/routes")
        || inside(path, "public")
        || path == "src/entry-client.tsx"
        || path == "src/entry-server.tsx"
    {
        return Ok(Change::Presentation);
    }
    if path.starts_with("wrangler.") || path == "vite.config.ts" || path == "app.config.ts" {
        return Ok(Change::WorkerConfiguration);
    }
    if path == "tools/cloudflare-alerts.ts" || path == "tools/cloudflare-alerts-plan.ts" {
        return Ok(Change::CloudflareAlerts);
    }
    if path == "tools/uptime.ts" || path == "tools/uptime-plan.ts" {
        return Ok(Change::Monitors);
    }
    if inside(path, "sources") || inside(path, "data") {
        return Ok(Change::Dataset);
    }
    if inside(path, "docs") || path.starts_with("README") || path.starts_with("LICENSE") {
        return Ok(Change::Documentation);
    }
    if inside(path, "tools")
        || inside(path, "verification")
        || inside(path, ".github")
        || inside(path, "tests")
        || path == "justfile"
        || path.starts_with("mise.")
        || path.starts_with("package")
        || path.starts_with("tsconfig")
        || path == "biome.json"
        || path == ".gitignore"
    {
        return Ok(Change::Automation);
    }
    Ok(Change::Unknown)
}

fn source_version(root: &Path, source: &Revision, target: &str) -> Result<String> {
    let object = format!("{source}:{target}/version.txt");
    let size = String::from_utf8(git(root, &["cat-file", "-s", &object])?)?
        .trim()
        .parse::<usize>()?;
    ensure!(
        size <= Version::MAXIMUM_BYTES + 1,
        "Oversized {target} version input"
    );
    let bytes = git(root, &["show", &object])?;
    let value = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
    let version = Version::parse(value)
        .map_err(|error| anyhow::anyhow!("Invalid {target} version: {error:?}"))?;
    Ok(version.to_string())
}

pub fn current_version(root: &Path, target: &str) -> Result<Version> {
    ensure!(["ios", "android"].contains(&target), "Unknown app version");
    let path = root.join(target).join("version.txt");
    ensure!(
        std::fs::metadata(&path)?.len() <= (Version::MAXIMUM_BYTES + 1) as u64,
        "Oversized app version input"
    );
    let bytes = std::fs::read(path)?;
    Version::parse(bytes.strip_suffix(b"\n").unwrap_or(&bytes))
        .map_err(|error| anyhow::anyhow!("Invalid {target} version: {error:?}"))
}

pub fn plan(
    root: &Path,
    source: Revision,
    base: Option<Revision>,
    requested: Option<Vec<Target>>,
    dataset: Option<Digest>,
) -> Result<PlanRecord> {
    require_repository(root)?;
    let versions = Versions {
        ios: source_version(root, &source, "ios")?,
        android: source_version(root, &source, "android")?,
    };
    let paths = if let Some(base) = &base {
        git(
            root,
            &[
                "merge-base",
                "--is-ancestor",
                base.as_str(),
                source.as_str(),
            ],
        )?;
        git(
            root,
            &[
                "diff",
                "--name-only",
                "--no-renames",
                "-z",
                base.as_str(),
                source.as_str(),
                "--",
            ],
        )?
    } else {
        Vec::new()
    };
    let mut changed = Vec::new();
    let mut affected = if base.is_some() {
        Impact::NONE
    } else {
        impact(Change::Unknown)
    };
    let unique: BTreeSet<_> = paths
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| std::str::from_utf8(path).context("Changed paths must be UTF-8"))
        .collect::<Result<_>>()?;
    for path in unique {
        let change = classify(path)?;
        affected = affected.union(impact(change));
        changed.push(ChangedInput {
            path: path.to_owned(),
            category: category(change).to_owned(),
        });
    }
    let requested = requested.map(|targets| {
        targets
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
    });
    let decision = Plan::new(affected, requested.as_deref().map(Target::combine));
    PlanRecord::seal(PlanBody {
        format: PLAN_FORMAT,
        repository: REPOSITORY.to_owned(),
        source,
        base,
        requested,
        dataset,
        versions,
        changed,
        targets: Target::members(decision.targets),
        checks: crate::model::Check::members(decision.checks),
        selection_required: decision.selection_required,
    })
}

pub fn validate_plan(root: &Path, record: &PlanRecord) -> Result<()> {
    record.validate_digest()?;
    let expected = plan(
        root,
        record.plan.source.clone(),
        record.plan.base.clone(),
        record.plan.requested.clone(),
        record.plan.dataset.clone(),
    )?;
    ensure!(
        expected == *record,
        "The delivery plan doesn't match the committed source or current planning rules"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_worker_and_account_configuration_paths_have_distinct_owners() -> Result<()> {
        for path in ["src/ui/search.css", "src/routes/index.tsx"] {
            assert_eq!(classify(path)?, Change::Presentation);
        }
        assert_eq!(classify("wrangler.jsonc")?, Change::WorkerConfiguration);
        assert_eq!(classify("ios/Sources/Phonebook/App.swift")?, Change::Ios);
        assert_eq!(
            classify("android/app/src/main/Example.kt")?,
            Change::Android
        );
        assert_eq!(
            classify("tools/cloudflare-alerts-plan.ts")?,
            Change::CloudflareAlerts
        );
        assert_eq!(classify("tools/uptime-plan.ts")?, Change::Monitors);
        assert_eq!(classify("src/server/api.ts")?, Change::ServerContract);
        assert_eq!(
            classify("src/core/kanji-variants.ts")?,
            Change::SharedSource
        );
        assert_eq!(classify("src/unknown/runtime.ts")?, Change::Unknown);
        Ok(())
    }
    #[test]
    fn invalid_or_deceptive_repository_paths_are_not_classified() {
        for path in [
            "",
            "../ios/app.swift",
            "/ios/app.swift",
            "ios//app.swift",
            "ios/../app.swift",
            "ios\\app.swift",
            "ios/app\n.swift",
        ] {
            assert!(classify(path).is_err());
        }
        assert_eq!(classify("ios-other/App.swift").ok(), Some(Change::Unknown));
    }
}
