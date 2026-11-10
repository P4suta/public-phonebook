use crate::model::{REPOSITORY, Revision};
use anyhow::{Context, Result, ensure};
use delivery_core::{Change, Version};
use std::{
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
    if path == "packages/directory/src/kanji-variants.ts"
        || path == "apps/web/src/ui/icons.tsx"
        || matches!(
            path,
            "apps/ios/Sources/PhonebookKit/PlaceReadings.json"
                | "apps/ios/Tests/PhonebookKitTests/PlaceReadingContract.json"
        )
        || inside(path, "design")
    {
        return Ok(Change::SharedSource);
    }
    if inside(path, "packages/directory/src") {
        return Ok(Change::SharedSource);
    }
    if inside(path, "apps/web/src/server")
        || path == "apps/ios/Tests/PhonebookCoreTests/SearchContract.json"
        || path == "apps/ios/Tests/PhonebookKitTests/DirectoryContract.json"
    {
        return Ok(Change::ServerContract);
    }
    if inside(path, "apps/ios") {
        return Ok(Change::Ios);
    }
    if inside(path, "apps/android") {
        return Ok(Change::Android);
    }
    if inside(path, "apps/web/src/ui")
        || inside(path, "apps/web/src/routes")
        || inside(path, "apps/web/public")
        || path == "apps/web/src/entry-client.tsx"
        || path == "apps/web/src/entry-server.tsx"
    {
        return Ok(Change::Presentation);
    }
    if path.starts_with("wrangler.") || path == "apps/web/vite.config.ts" || path == "app.config.ts"
    {
        return Ok(Change::WorkerConfiguration);
    }
    if path == "infrastructure/cloudflare/src/cloudflare-alerts.ts"
        || path == "infrastructure/cloudflare/src/cloudflare-alerts-plan.ts"
    {
        return Ok(Change::CloudflareAlerts);
    }
    if path == "infrastructure/cloudflare/src/uptime.ts"
        || path == "infrastructure/cloudflare/src/uptime-plan.ts"
    {
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

pub fn current_version(root: &Path, target: &str) -> Result<Version> {
    ensure!(["ios", "android"].contains(&target), "Unknown app version");
    let path = root.join("apps").join(target).join("version.txt");
    ensure!(
        std::fs::metadata(&path)?.len() <= (Version::MAXIMUM_BYTES + 1) as u64,
        "Oversized app version input"
    );
    let bytes = std::fs::read(path)?;
    Version::parse(bytes.strip_suffix(b"\n").unwrap_or(&bytes))
        .map_err(|error| anyhow::anyhow!("Invalid {target} version: {error:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_worker_and_account_configuration_paths_have_distinct_owners() -> Result<()> {
        for path in [
            "apps/web/src/ui/search.css",
            "apps/web/src/routes/index.tsx",
        ] {
            assert_eq!(classify(path)?, Change::Presentation);
        }
        assert_eq!(classify("wrangler.jsonc")?, Change::WorkerConfiguration);
        assert_eq!(
            classify("apps/ios/Sources/Phonebook/App.swift")?,
            Change::Ios
        );
        assert_eq!(
            classify("apps/android/app/src/main/Example.kt")?,
            Change::Android
        );
        assert_eq!(
            classify("infrastructure/cloudflare/src/cloudflare-alerts-plan.ts")?,
            Change::CloudflareAlerts
        );
        assert_eq!(
            classify("infrastructure/cloudflare/src/uptime-plan.ts")?,
            Change::Monitors
        );
        assert_eq!(
            classify("apps/web/src/server/api.ts")?,
            Change::ServerContract
        );
        assert_eq!(
            classify("packages/directory/src/kanji-variants.ts")?,
            Change::SharedSource
        );
        assert_eq!(
            classify("apps/web/src/unknown/runtime.ts")?,
            Change::Unknown
        );
        for path in [
            "apps/ios/Sources/PhonebookKit/PlaceReadings.json",
            "apps/ios/Tests/PhonebookKitTests/PlaceReadingContract.json",
        ] {
            assert_eq!(classify(path)?, Change::SharedSource);
        }
        Ok(())
    }
    #[test]
    fn invalid_or_deceptive_repository_paths_are_not_classified() {
        for path in [
            "",
            "../ios/app.swift",
            "/ios/app.swift",
            "apps/ios//app.swift",
            "apps/ios/../app.swift",
            "ios\\app.swift",
            "apps/ios/app\n.swift",
        ] {
            assert!(classify(path).is_err());
        }
        assert_eq!(classify("ios-other/App.swift").ok(), Some(Change::Unknown));
    }
}
