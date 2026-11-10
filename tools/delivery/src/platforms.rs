use crate::{
    model::Digest,
    repository::{classify, completed},
    runtime::{read_json, write_json},
    versions::App,
};
use anyhow::{Context, Result, ensure};
use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env,
    ffi::OsStr,
    fs,
    path::Path,
    process::{Command, Stdio},
};

const IOS_COMMANDS: [&str; 3] = ["ios-check", "ios-sanitize", "ios-mutate"];
const ANDROID_COMMANDS: [&str; 2] = ["android-check", "android-mutate"];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Check,
    #[default]
    Full,
}

impl Scope {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Check => "check",
            Self::Full => "full",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlatformInputs {
    format: u32,
    app: App,
    scope: Scope,
    sources: BTreeMap<String, Digest>,
    commands: Vec<String>,
    environment: BTreeMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    pub inputs: PlatformInputs,
    pub passed: bool,
    pub outputs: BTreeMap<String, Digest>,
}

fn under(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

pub fn reads(app: App, path: &str) -> Result<bool> {
    let classification = classify(path)?;
    if ["docs", "releases", "apps/web/src/routes"]
        .iter()
        .any(|prefix| under(path, prefix))
        || path.starts_with("README")
    {
        return Ok(false);
    }
    if under(path, "apps/web/src/ui") && path != "apps/web/src/ui/icons.tsx" {
        return Ok(false);
    }
    let excluded: &[&str] = match app {
        App::Ios => &["apps/android", "verification/android"],
        App::Android => &["apps/ios", "verification/ios", "tools/ios-check"],
    };
    let shared = matches!(
        classification,
        delivery_core::Change::SharedSource | delivery_core::Change::ServerContract
    );
    let proof_base = app == App::Android && path == "verification/ios/Dockerfile";
    Ok(shared || proof_base || !excluded.iter().any(|prefix| under(path, prefix)))
}

fn output(program: impl AsRef<OsStr>, arguments: &[&str]) -> Result<String> {
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

#[derive(Debug, Deserialize, Serialize)]
struct SimulatorRuntime {
    identifier: String,
    version: String,
    #[serde(rename = "buildversion")]
    build: String,
    #[serde(rename = "isAvailable")]
    available: bool,
}

fn simulator_runtimes(report: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Report {
        runtimes: Vec<SimulatorRuntime>,
    }
    let mut runtimes = serde_json::from_str::<Report>(report)?.runtimes;
    runtimes.retain(|runtime| {
        runtime
            .identifier
            .starts_with("com.apple.CoreSimulator.SimRuntime.iOS-")
            || runtime
                .identifier
                .starts_with("com.apple.CoreSimulator.SimRuntime.watchOS-")
    });
    runtimes.sort_by(|left, right| left.identifier.cmp(&right.identifier));
    ensure!(
        !runtimes.is_empty()
            && runtimes
                .iter()
                .all(|runtime| !runtime.version.is_empty() && !runtime.build.is_empty())
            && runtimes
                .windows(2)
                .all(|pair| pair[0].identifier != pair[1].identifier),
        "Missing, malformed, or duplicate Apple simulator runtime identities"
    );
    Ok(serde_json::to_string(&runtimes)?)
}

pub fn inputs(root: &Path, app: App, scope: Scope) -> Result<PlatformInputs> {
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
            .any(|path| path.starts_with(&format!("apps/{}/", app.name()))),
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
            environment.insert("macos".to_owned(), output("sw_vers", &[])?);
            environment.insert(
                "simulatorRuntimes".to_owned(),
                simulator_runtimes(&output("xcrun", &["simctl", "list", "runtimes", "--json"])?)?,
            );
            environment.insert(
                "developerDirectory".to_owned(),
                env::var("DEVELOPER_DIR").unwrap_or(output("xcode-select", &["-p"])?),
            );
            IOS_COMMANDS.as_slice()
        }
        App::Android => {
            let wrapper = if cfg!(windows) {
                "gradlew.bat"
            } else {
                "gradlew"
            };
            environment.insert(
                "gradle".to_owned(),
                output(root.join("apps/android").join(wrapper), &["--version"])?,
            );
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
    let commands = match scope {
        Scope::Full => commands,
        Scope::Check => &commands[..1],
    };
    Ok(PlatformInputs {
        format: 2,
        app,
        scope,
        sources,
        commands: commands
            .iter()
            .map(|command| (*command).to_owned())
            .collect(),
        environment,
    })
}

fn output_paths(app: App, scope: Scope) -> &'static [&'static str] {
    match (app, scope) {
        (App::Ios, Scope::Check) => &["target/ios/receipt.json"],
        (App::Ios, Scope::Full) => &[
            "target/ios/receipt.json",
            "target/ios/sanitizer-receipt.json",
            "target/ios/mutation-receipt.json",
        ],
        (App::Android, Scope::Check) => &["target/android/gradle-check.txt"],
        (App::Android, Scope::Full) => &[
            "target/android/gradle-check.txt",
            "target/android/mutation/receipt.json",
        ],
    }
}

fn outputs(root: &Path, current: &PlatformInputs) -> Result<BTreeMap<String, Digest>> {
    output_paths(current.app, current.scope)
        .iter()
        .map(|path| {
            let bytes = fs::read(root.join(path))
                .with_context(|| format!("Cannot read platform verification output {path}"))?;
            Ok(((*path).to_owned(), Digest::of(&bytes)))
        })
        .collect()
}

pub fn reusable(root: &Path, receipt: &Receipt, current: &PlatformInputs) -> bool {
    delivery_core::reuse_evidence(
        receipt.inputs.format == 2
            && receipt.inputs.app == current.app
            && receipt.inputs.scope == current.scope
            && receipt.inputs.sources == current.sources,
        receipt.inputs.commands == current.commands,
        receipt.inputs.environment == current.environment,
        receipt.passed && outputs(root, current).is_ok_and(|actual| actual == receipt.outputs),
    )
}

pub fn key(root: &Path, app: App, scope: Scope) -> Result<Digest> {
    Ok(Digest::of(&serde_json::to_vec(&inputs(root, app, scope)?)?))
}

pub fn verify(root: &Path, app: App, scope: Scope) -> Result<()> {
    let current = inputs(root, app, scope)?;
    let suffix = if scope == Scope::Check { "-check" } else { "" };
    let path = root.join(format!(
        "target/delivery/platforms/{}{suffix}.json",
        app.name()
    ));
    if path.exists() {
        if let Ok(receipt) = read_json::<Receipt>(&path)
            && reusable(root, &receipt, &current)
        {
            println!("Reused matching {} assurance evidence", app.name());
            return Ok(());
        }
        fs::remove_file(&path)?;
    }
    let commands = if scope == Scope::Full {
        verify(root, app, Scope::Check)?;
        &current.commands[1..]
    } else {
        &current.commands[..]
    };
    for recipe in commands {
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
        current == inputs(root, app, scope)?,
        "Platform inputs changed during verification"
    );
    write_json(
        &path,
        &Receipt {
            outputs: outputs(root, &current)?,
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
    fn runtime_identity_changes_invalidate_reuse_while_usage_and_mount_paths_do_not() -> Result<()>
    {
        let runtime = serde_json::json!({
            "identifier":"com.apple.CoreSimulator.SimRuntime.iOS-27-0",
            "version":"27.0", "buildversion":"24A434", "isAvailable":true,
            "runtimeRoot":"/mount/first", "lastUsage":{"arm64":"earlier"},
        });
        let normalized =
            simulator_runtimes(&serde_json::json!({"runtimes":[runtime.clone()]}).to_string())?;
        let watch = serde_json::json!({
            "identifier":"com.apple.CoreSimulator.SimRuntime.watchOS-27-0",
            "version":"27.0", "buildversion":"24R362", "isAvailable":true,
        });
        let mut updated_watch = watch.clone();
        updated_watch["buildversion"] = serde_json::json!("24R363");
        assert_ne!(
            simulator_runtimes(
                &serde_json::json!({"runtimes":[runtime.clone(),watch]}).to_string()
            )?,
            simulator_runtimes(
                &serde_json::json!({"runtimes":[runtime.clone(),updated_watch]}).to_string()
            )?
        );
        let mut updated = runtime.clone();
        updated["runtimeRoot"] = serde_json::json!("/mount/second");
        updated["lastUsage"] = serde_json::json!({"arm64":"later"});
        assert_eq!(
            normalized,
            simulator_runtimes(&serde_json::json!({"runtimes":[updated]}).to_string())?
        );
        for (field, value) in [
            ("version", serde_json::json!("27.0.1")),
            ("buildversion", serde_json::json!("24A435")),
            ("isAvailable", serde_json::json!(false)),
        ] {
            let mut updated = runtime.clone();
            updated[field] = value;
            assert_ne!(
                normalized,
                simulator_runtimes(&serde_json::json!({"runtimes":[updated]}).to_string())?
            );
        }
        for invalid in [
            serde_json::json!({"runtimes":[]}),
            serde_json::json!({"runtimes":[runtime.clone(),runtime]}),
            serde_json::json!({"runtimes":[{"identifier":"incomplete"}]}),
        ] {
            assert!(simulator_runtimes(&invalid.to_string()).is_err());
        }
        Ok(())
    }

    #[test]
    fn a_selected_comparison_base_cannot_remove_client_input_validation() -> Result<()> {
        for app in [App::Ios, App::Android] {
            assert!(!reads(app, "apps/web/src/ui/search.css")?);
            assert!(reads(app, "apps/web/src/server/datasets.ts")?);
            assert!(reads(
                app,
                "apps/ios/Tests/PhonebookCoreTests/SearchContract.json"
            )?);
            assert!(reads(app, "unknown/generator")?);
            assert!(reads(
                app,
                "apps/ios/Sources/PhonebookKit/PlaceReadings.json"
            )?);
            assert!(reads(
                app,
                "apps/ios/Tests/PhonebookKitTests/PlaceReadingContract.json"
            )?);
        }
        assert!(!reads(App::Android, "apps/ios/App/Directory.swift")?);
        assert!(!reads(App::Ios, "apps/android/app/src/Main.kt")?);
        assert!(reads(App::Ios, "tools/android-check/src/main.rs")?);
        assert!(reads(App::Android, "verification/ios/Dockerfile")?);
        assert!(reads(App::Android, "LICENSE-APACHE")?);
        Ok(())
    }
    #[test]
    fn matching_metadata_without_native_outputs_cannot_replace_verification() -> Result<()> {
        let root = tempfile::tempdir()?;
        let current = PlatformInputs {
            format: 2,
            app: App::Ios,
            scope: Scope::Check,
            sources: BTreeMap::from([("App.swift".to_owned(), Digest::of(b"source"))]),
            commands: vec!["ios-check".to_owned()],
            environment: BTreeMap::new(),
        };
        let receipt = Receipt {
            inputs: current.clone(),
            passed: true,
            outputs: BTreeMap::new(),
        };
        assert!(!reusable(root.path(), &receipt, &current));
        let error = outputs(root.path(), &current)
            .err()
            .context("The native output should be missing")?;
        assert!(error.to_string().contains("target/ios/receipt.json"));
        Ok(())
    }

    #[test]
    fn receipts_refuse_changed_added_removed_inputs_commands_and_environments() -> Result<()> {
        let root = tempfile::tempdir()?;
        fs::create_dir_all(root.path().join("target/ios"))?;
        fs::write(
            root.path().join("target/ios/receipt.json"),
            b"native result",
        )?;
        let current = PlatformInputs {
            format: 2,
            app: App::Ios,
            scope: Scope::Check,
            sources: BTreeMap::from([("App.swift".to_owned(), Digest::of(b"source"))]),
            commands: vec!["ios-check".to_owned()],
            environment: BTreeMap::from([("xcode".to_owned(), "pinned".to_owned())]),
        };
        let mut receipt = Receipt {
            inputs: current.clone(),
            passed: true,
            outputs: outputs(root.path(), &current)?,
        };
        assert!(reusable(root.path(), &receipt, &current));
        receipt
            .inputs
            .sources
            .insert("New.swift".to_owned(), Digest::of(b"added"));
        assert!(!reusable(root.path(), &receipt, &current));
        receipt.inputs.sources.clear();
        assert!(!reusable(root.path(), &receipt, &current));
        receipt.inputs = current.clone();
        receipt.inputs.commands.clear();
        assert!(!reusable(root.path(), &receipt, &current));
        receipt.inputs = current.clone();
        receipt.inputs.environment.clear();
        assert!(!reusable(root.path(), &receipt, &current));
        receipt.inputs = current.clone();
        receipt.inputs.scope = Scope::Full;
        assert!(!reusable(root.path(), &receipt, &current));
        receipt.inputs = current.clone();
        fs::write(root.path().join("target/ios/receipt.json"), b"changed")?;
        assert!(!reusable(root.path(), &receipt, &current));
        fs::remove_file(root.path().join("target/ios/receipt.json"))?;
        assert!(!reusable(root.path(), &receipt, &current));
        receipt.inputs = current;
        receipt.passed = false;
        assert!(!reusable(root.path(), &receipt, &receipt.inputs));
        Ok(())
    }
}
