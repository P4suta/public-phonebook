use crate::{
    model::Digest,
    repository::{classify, completed},
    runtime::{read_json, write_json},
    versions::App,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    path::Path,
    process::{Command, Stdio},
};

const IOS_COMMANDS: [&str; 3] = ["ios-check", "ios-sanitize", "ios-mutate"];
const ANDROID_COMMANDS: [&str; 2] = ["android-check", "android-mutate"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlatformInputs {
    format: u32,
    app: App,
    sources: BTreeMap<String, Digest>,
    commands: Vec<String>,
    environment: BTreeMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    pub inputs: PlatformInputs,
    pub passed: bool,
}

fn under(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

pub fn reads(app: App, path: &str) -> Result<bool> {
    classify(path)?;
    if ["docs", "releases", "src/routes"]
        .iter()
        .any(|prefix| under(path, prefix))
        || path.starts_with("README")
    {
        return Ok(false);
    }
    if under(path, "src/ui") && path != "src/ui/icons.tsx" {
        return Ok(false);
    }
    let excluded: &[&str] = match app {
        App::Ios => &["android", "verification/android"],
        App::Android => &["ios", "verification/ios", "tools/ios-check"],
    };
    let fixture = matches!(
        path,
        "ios/Tests/PhonebookCoreTests/SearchContract.json"
            | "ios/Tests/PhonebookKitTests/DirectoryContract.json"
    );
    let proof_base = app == App::Android && path == "verification/ios/Dockerfile";
    Ok(fixture || proof_base || !excluded.iter().any(|prefix| under(path, prefix)))
}

fn output(program: &str, arguments: &[&str]) -> Result<String> {
    let mut command = Command::new(program);
    command.args(arguments);
    let output = completed(command)?;
    Ok(format!(
        "{}{}",
        String::from_utf8(output.stdout)?,
        String::from_utf8(output.stderr)?
    )
    .trim()
    .to_owned())
}

pub fn inputs(root: &Path, app: App) -> Result<PlatformInputs> {
    let mut git = Command::new("git");
    git.current_dir(root).args([
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
    ]);
    let listing = String::from_utf8(completed(git)?.stdout)?;
    let mut sources = BTreeMap::new();
    for path in listing.split('\0').filter(|path| !path.is_empty()) {
        if reads(app, path)? {
            sources.insert(
                path.to_owned(),
                Digest::of(
                    &fs::read(root.join(path))
                        .with_context(|| format!("Missing platform verification input {path}"))?,
                ),
            );
        }
    }
    ensure!(
        sources
            .keys()
            .any(|path| path.starts_with(&format!("{}/", app.name()))),
        "No platform source inputs"
    );
    let mut environment = BTreeMap::from([
        ("os".to_owned(), env::consts::OS.to_owned()),
        ("architecture".to_owned(), env::consts::ARCH.to_owned()),
        ("node".to_owned(), output("node", &["--version"])?),
        (
            "rust".to_owned(),
            output("rustc", &["--version", "--verbose"])?,
        ),
    ]);
    let commands = match app {
        App::Ios => {
            ensure!(
                cfg!(target_os = "macos"),
                "iOS assurance requires the documented macOS runner"
            );
            environment.insert("xcode".to_owned(), output("xcodebuild", &["-version"])?);
            environment.insert(
                "developerDirectory".to_owned(),
                env::var("DEVELOPER_DIR").unwrap_or(output("xcode-select", &["-p"])?),
            );
            IOS_COMMANDS.as_slice()
        }
        App::Android => {
            environment.insert("gradle".to_owned(), output("gradle", &["--version"])?);
            let sdk = env::var_os("ANDROID_HOME")
                .or_else(|| env::var_os("ANDROID_SDK_ROOT"))
                .context("Set ANDROID_HOME for platform evidence")?;
            for relative in [
                "platforms/android-37.0/source.properties",
                "build-tools/36.0.0/source.properties",
            ] {
                environment.insert(
                    relative.to_owned(),
                    fs::read_to_string(Path::new(&sdk).join(relative))?,
                );
            }
            ANDROID_COMMANDS.as_slice()
        }
    };
    Ok(PlatformInputs {
        format: 1,
        app,
        sources,
        commands: commands
            .iter()
            .map(|command| (*command).to_owned())
            .collect(),
        environment,
    })
}

pub fn reusable(receipt: &Receipt, current: &PlatformInputs) -> bool {
    delivery_core::reuse_evidence(
        receipt.inputs.format == 1
            && receipt.inputs.app == current.app
            && receipt.inputs.sources == current.sources,
        receipt.inputs.commands == current.commands,
        receipt.inputs.environment == current.environment,
        receipt.passed,
    )
}

pub fn key(root: &Path, app: App) -> Result<Digest> {
    Ok(Digest::of(&serde_json::to_vec(&inputs(root, app)?)?))
}

pub fn verify(root: &Path, app: App) -> Result<()> {
    let current = inputs(root, app)?;
    let path = root.join(format!("target/delivery/platforms/{}.json", app.name()));
    if path.exists() {
        let receipt: Receipt = read_json(&path)?;
        if reusable(&receipt, &current) {
            println!("Reused matching {} assurance evidence", app.name());
            return Ok(());
        }
        fs::remove_file(&path)?;
    }
    for recipe in &current.commands {
        let status = Command::new("just")
            .current_dir(root)
            .arg(recipe)
            .stdin(Stdio::null())
            .status()?;
        ensure!(
            status.success(),
            "{recipe} didn't complete successfully; no platform evidence was recorded"
        );
    }
    ensure!(
        current == inputs(root, app)?,
        "Platform inputs changed during verification"
    );
    write_json(
        &path,
        &Receipt {
            inputs: current,
            passed: true,
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_selected_comparison_base_cannot_remove_client_input_validation() -> Result<()> {
        for app in [App::Ios, App::Android] {
            assert!(!reads(app, "src/ui/search.css")?);
            assert!(reads(app, "src/server/datasets.ts")?);
            assert!(reads(
                app,
                "ios/Tests/PhonebookCoreTests/SearchContract.json"
            )?);
            assert!(reads(app, "unknown/generator")?);
        }
        assert!(!reads(App::Android, "ios/App/Directory.swift")?);
        assert!(!reads(App::Ios, "android/app/src/Main.kt")?);
        assert!(reads(App::Ios, "tools/android-check/src/main.rs")?);
        assert!(reads(App::Android, "verification/ios/Dockerfile")?);
        assert!(reads(App::Android, "LICENSE-APACHE")?);
        Ok(())
    }
    #[test]
    fn receipts_refuse_changed_added_removed_inputs_commands_and_environments() {
        let current = PlatformInputs {
            format: 1,
            app: App::Ios,
            sources: BTreeMap::from([("App.swift".to_owned(), Digest::of(b"source"))]),
            commands: vec!["ios-check".to_owned()],
            environment: BTreeMap::from([("xcode".to_owned(), "pinned".to_owned())]),
        };
        let mut receipt = Receipt {
            inputs: current.clone(),
            passed: true,
        };
        assert!(reusable(&receipt, &current));
        receipt
            .inputs
            .sources
            .insert("New.swift".to_owned(), Digest::of(b"added"));
        assert!(!reusable(&receipt, &current));
        receipt.inputs.sources.clear();
        assert!(!reusable(&receipt, &current));
        receipt.inputs = current.clone();
        receipt.inputs.commands.clear();
        assert!(!reusable(&receipt, &current));
        receipt.inputs = current.clone();
        receipt.inputs.environment.clear();
        assert!(!reusable(&receipt, &current));
        receipt.inputs = current;
        receipt.passed = false;
        assert!(!reusable(&receipt, &receipt.inputs));
    }
}
