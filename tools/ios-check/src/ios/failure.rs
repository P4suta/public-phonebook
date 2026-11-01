//! Keeps what explains a failed UI scenario where the Native assurance job uploads it.

use super::without_secrets;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    ffi::{OsStr, OsString},
    fs,
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

/// The directory, relative to the repository root, that holds one subdirectory per failed scenario.
pub const EVIDENCE: &str = "target/ios/ui-failures";
/// The app's unified logging subsystem, whose info messages name the failing directory phase.
pub const APP_SUBSYSTEM: &str = "page.dial.publicphonebook";
const TEST_CLASS: &str = "DirectoryUITests";
const SIMULATOR_LOG: &str = "simulator.log";
const ATTACHMENTS: &str = "attachments";
const SIMULATOR_LOG_PREDICATE: &str = "subsystem == \"page.dial.publicphonebook\" OR (messageType != info AND (process == \"PublicPhonebook\" OR process == \"PhonebookUITests-Runner\" OR process == \"SpringBoard\" OR process == \"runningboardd\" OR process == \"testmanagerd\"))";
const MILLISECONDS_PER_SECOND: f64 = 1000.0;

/// Runs the Apple tools that read result bundles and simulator logs.
pub trait Tools {
    /// Runs a program to completion and returns its standard output, or an error with its standard error.
    fn output(&self, program: &str, arguments: &[OsString]) -> Result<Vec<u8>>;
}

/// The installed Xcode tools, run without the signing and delivery secrets.
pub struct Xcode;

impl Tools for Xcode {
    fn output(&self, program: &str, arguments: &[OsString]) -> Result<Vec<u8>> {
        let output = without_secrets(Command::new(program).args(arguments))
            .output()
            .with_context(|| format!("Start {program}"))?;
        ensure!(
            output.status.success(),
            "{program} failed with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        Ok(output.stdout)
    }
}

/// A failed scenario run whose result bundle and simulator remain available.
pub struct Scenario<'a> {
    pub root: &'a Path,
    pub simulator: &'a str,
    pub name: &'a str,
    pub bundle: &'a Path,
    pub started: SystemTime,
}

/// A failing assertion and its source locations, innermost first.
#[derive(Debug, PartialEq, Eq)]
pub struct Failure {
    pub text: String,
    pub locations: Vec<String>,
}

/// The kept evidence of one failed scenario.
pub struct Evidence {
    pub directory: String,
    pub failures: Vec<Failure>,
    pub errors: Vec<String>,
}

impl Evidence {
    pub fn record(&self) -> Value {
        json!({
            "directory": self.directory,
            "failures": self.failures.iter().map(failure_record).collect::<Vec<_>>(),
            "export_errors": self.errors,
        })
    }
}

fn failure_record(failure: &Failure) -> Value {
    json!({"text": failure.text, "locations": failure.locations})
}

/// Exports the failing assertions, the step timeline, the attachments, and the simulator log of a failed scenario.
pub fn keep(scenario: &Scenario, tools: &impl Tools) -> Result<Evidence> {
    let relative = Path::new(EVIDENCE).join(scenario.name);
    let directory = scenario.root.join(&relative);
    if directory.exists() {
        fs::remove_dir_all(&directory)?;
    }
    fs::create_dir_all(directory.join(ATTACHMENTS))?;
    let mut errors = Vec::new();
    let test = format!("{TEST_CLASS}/{}()", scenario.name);
    let bundle = scenario.bundle.as_os_str();
    let read = |kind: &str, selector: &[&str], file: &str| -> Result<Value> {
        let mut arguments = arguments(&["xcresulttool", "get", "test-results", kind]);
        arguments.extend(selector.iter().map(OsString::from));
        arguments.extend([OsString::from("--path"), bundle.to_owned()]);
        let output = tools.output("xcrun", &arguments)?;
        fs::write(directory.join(file), &output)?;
        Ok(serde_json::from_slice(&output)?)
    };
    let summary = noted(&mut errors, "summary", read("summary", &[], "summary.json"));
    let details = noted(
        &mut errors,
        "test details",
        read("test-details", &["--test-id", &test], "details.json"),
    );
    let activities = noted(
        &mut errors,
        "activities",
        read("activities", &["--test-id", &test], "activities.json"),
    );
    let exported = directory.join(ATTACHMENTS);
    let listed = noted(
        &mut errors,
        "attachments",
        export_attachments(bundle, &exported, tools),
    );
    let log = simulator_log(scenario, tools)
        .and_then(|output| Ok(fs::write(directory.join(SIMULATOR_LOG), output)?));
    noted(&mut errors, "simulator log", log);
    let summary = summary.unwrap_or_default();
    let failures = failures(&summary, &details.unwrap_or_default(), scenario.root);
    let report = json!({
        "test": scenario.name,
        "result": summary["result"],
        "bundle": repository_path(&scenario.bundle.to_string_lossy(), scenario.root),
        "failures": failures.iter().map(failure_record).collect::<Vec<_>>(),
        "timeline": timeline(&activities.unwrap_or_default(), summary["finishTime"].as_f64()),
        "attachments": listed.unwrap_or_default(),
        "simulator_log": SIMULATOR_LOG,
        "export_errors": errors,
    });
    fs::write(
        directory.join("failure.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(Evidence {
        directory: relative.display().to_string(),
        failures,
        errors,
    })
}

fn arguments(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

/// Keeps a successful export and records a failed one so the report names every gap.
fn noted<T>(errors: &mut Vec<String>, step: &str, result: Result<T>) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(error) => {
            errors.push(format!("{step}: {error:#}"));
            None
        }
    }
}

fn export_attachments(bundle: &OsStr, output: &Path, tools: &impl Tools) -> Result<Vec<Value>> {
    let mut command = arguments(&["xcresulttool", "export", "attachments", "--path"]);
    command.extend([
        bundle.to_owned(),
        OsString::from("--output-path"),
        output.as_os_str().to_owned(),
    ]);
    tools.output("xcrun", &command)?;
    attachments(&serde_json::from_slice(&fs::read(
        output.join("manifest.json"),
    )?)?)
}

fn simulator_log(scenario: &Scenario, tools: &impl Tools) -> Result<Vec<u8>> {
    let since = scenario.started.duration_since(UNIX_EPOCH)?.as_secs();
    let mut command = arguments(&["simctl", "spawn", scenario.simulator]);
    command.extend(arguments(&[
        "log",
        "show",
        "--style",
        "compact",
        "--info",
        "--predicate",
        SIMULATOR_LOG_PREDICATE,
        "--start",
    ]));
    command.push(OsString::from(format!("@{since}")));
    tools.output("xcrun", &command)
}

/// Lists the exported attachments by their test-given names.
fn attachments(manifest: &Value) -> Result<Vec<Value>> {
    manifest
        .as_array()
        .context("The attachment manifest is not a list")?
        .iter()
        .flat_map(|test| test["attachments"].as_array().into_iter().flatten())
        .map(|attachment| {
            let file = attachment["exportedFileName"]
                .as_str()
                .context("An attachment has no exported file")?;
            ensure!(
                !file.is_empty() && !file.contains('/') && !file.starts_with('.'),
                "Invalid exported attachment name"
            );
            Ok(json!({
                "name": attachment["suggestedHumanReadableName"],
                "file": Path::new(ATTACHMENTS).join(file),
                "failure": attachment["isAssociatedWithFailure"],
            }))
        })
        .collect()
}

/// Pairs each failing assertion with the source locations that the test details record for it.
pub fn failures(summary: &Value, details: &Value, root: &Path) -> Vec<Failure> {
    fn nodes<'a>(node: &'a Value, found: &mut Vec<&'a Value>) {
        found.push(node);
        for child in node["children"].as_array().into_iter().flatten() {
            nodes(child, found);
        }
    }
    let mut all = Vec::new();
    for run in details["testRuns"].as_array().into_iter().flatten() {
        nodes(run, &mut all);
    }
    summary["testFailures"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|failure| failure["failureText"].as_str())
        .map(|text| {
            let locations = all
                .iter()
                .filter(|node| node["name"] == text)
                .flat_map(|node| {
                    let references = node["children"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|child| child["nodeType"] == "Source Code Reference")
                        .filter_map(|child| {
                            location(&child["sourceLocation"], child["name"].as_str(), root)
                        })
                        .collect::<Vec<_>>();
                    if references.is_empty() {
                        location(&node["sourceLocation"], None, root)
                            .into_iter()
                            .collect()
                    } else {
                        references
                    }
                })
                .collect();
            Failure {
                text: text.to_owned(),
                locations,
            }
        })
        .collect()
}

fn location(source: &Value, function: Option<&str>, root: &Path) -> Option<String> {
    let file = repository_path(source["filePath"].as_str()?, root);
    let line = source["lineNumber"].as_u64()?;
    Some(match function {
        Some(function) => format!("{file}:{line} in {function}"),
        None => format!("{file}:{line}"),
    })
}

/// Returns a repository-relative path, or only the file name for a path outside the repository.
fn repository_path(path: &str, root: &Path) -> String {
    let path = Path::new(path);
    path.strip_prefix(root)
        .ok()
        .or_else(|| path.file_name().map(Path::new))
        .unwrap_or(Path::new(""))
        .display()
        .to_string()
}

/// Lists the top-level test steps with their offset from the test start and the time until the next step.
pub fn timeline(activities: &Value, finish: Option<f64>) -> Vec<Value> {
    let steps = activities["testRuns"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|run| run["activities"].as_array().into_iter().flatten())
        .filter_map(|step| {
            Some((
                step["startTime"].as_f64()?,
                step["title"].as_str()?,
                step["isAssociatedWithFailure"] == true,
            ))
        })
        .collect::<Vec<_>>();
    let Some(&(origin, _, _)) = steps.first() else {
        return Vec::new();
    };
    steps
        .iter()
        .enumerate()
        .map(|(index, &(start, title, failed))| {
            let end = steps.get(index + 1).map(|next| next.0).or(finish);
            json!({
                "at_seconds": rounded(start - origin),
                "seconds": end.map(|end| rounded(end - start)),
                "step": title,
                "failure": failed,
            })
        })
        .collect()
}

fn rounded(seconds: f64) -> f64 {
    (seconds * MILLISECONDS_PER_SECOND).round() / MILLISECONDS_PER_SECOND
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::bail;

    const NAME: &str = "testOnboardingSavesTheDirectoryBeforeSearch";
    const ASSERTION: &str = "Waiting until the saved directory enables the finish button timed out after 60.4s. The screen shows no save progress and the save error “saving failed”.";
    const ALLOWANCE: &str = "Test exceeded execution time allowance of 2 minutes";

    /// Answers like Xcode for a scenario forced to fail, and refuses the requests it isn't given.
    struct Forced {
        root: std::path::PathBuf,
        bundle: bool,
        log: bool,
    }

    impl Forced {
        fn source(&self, line: u64) -> Value {
            json!({"filePath": self.root.join("ios/UITests/DirectoryUITests.swift"), "lineNumber": line})
        }
    }

    impl Tools for Forced {
        fn output(&self, program: &str, arguments: &[OsString]) -> Result<Vec<u8>> {
            let words = arguments
                .iter()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            let words = words.iter().map(String::as_str).collect::<Vec<_>>();
            let response = match (program, words.as_slice()) {
                ("xcrun", ["simctl", "spawn", "SIMULATOR", "log", "show", ..]) if self.log => {
                    json!("launch denied by SpringBoard")
                }
                ("xcrun", ["xcresulttool", "get", "test-results", "summary", ..])
                    if self.bundle =>
                {
                    json!({"result": "Failed", "finishTime": 170.0, "testFailures": [
                        {"failureText": ASSERTION}, {"failureText": ALLOWANCE}
                    ]})
                }
                (
                    "xcrun",
                    [
                        "xcresulttool",
                        "get",
                        "test-results",
                        "test-details",
                        "--test-id",
                        id,
                        ..,
                    ],
                ) if self.bundle && *id == format!("DirectoryUITests/{NAME}()") => {
                    json!({"testRuns": [{"children": [{"children": [
                        {"name": ASSERTION, "result": "Failed", "sourceLocation": self.source(42), "children": [
                            {"name": "DirectoryUITests.waitUntilSaved(_:in:timeout:file:line:)", "nodeType": "Source Code Reference", "sourceLocation": self.source(42)}
                        ]},
                        {"name": ALLOWANCE, "result": "Failed", "children": [{"name": "Spindump.txt", "nodeType": "Attachment"}]}
                    ]}]}]})
                }
                ("xcrun", ["xcresulttool", "get", "test-results", "activities", ..])
                    if self.bundle =>
                {
                    json!({"testRuns": [{"activities": [
                        {"title": "Start Test", "startTime": 100.0},
                        {"title": "Wait up to 60.0 s until the saved directory enables the finish button", "startTime": 102.5, "isAssociatedWithFailure": true},
                        {"title": "Tear Down", "startTime": 163.0}
                    ]}]})
                }
                (
                    "xcrun",
                    [
                        "xcresulttool",
                        "export",
                        "attachments",
                        "--path",
                        _,
                        "--output-path",
                        output,
                    ],
                ) if self.bundle => {
                    fs::write(Path::new(output).join("A.png"), "screenshot")?;
                    fs::write(
                        Path::new(output).join("manifest.json"),
                        serde_json::to_vec(&json!([{"attachments": [
                            {"exportedFileName": "A.png", "suggestedHumanReadableName": "failure_0_ID.png", "isAssociatedWithFailure": false}
                        ]}]))?,
                    )?;
                    json!("Exported 1 attachment")
                }
                _ => bail!("{program} refused {}", words.join(" ")),
            };
            Ok(serde_json::to_vec(&response)?)
        }
    }

    fn scenario<'a>(root: &'a Path, bundle: &'a Path) -> Scenario<'a> {
        Scenario {
            root,
            simulator: "SIMULATOR",
            name: NAME,
            bundle,
            started: UNIX_EPOCH,
        }
    }

    #[test]
    fn a_forced_failure_keeps_its_bundle_summary_assertions_and_attachments() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let root = directory.path();
        let bundle = root.join(format!("target/ios/ui-run/{NAME}.xcresult"));
        fs::create_dir_all(&bundle)?;
        let kept = root.join(EVIDENCE).join(NAME);
        fs::create_dir_all(&kept)?;
        fs::write(kept.join("stale.json"), "{}")?;
        let tools = Forced {
            root: root.to_owned(),
            bundle: true,
            log: false,
        };
        let evidence = keep(&scenario(root, &bundle), &tools)?;
        assert_eq!(evidence.directory, format!("{EVIDENCE}/{NAME}"));
        assert_eq!(
            evidence.failures,
            [
                Failure {
                    text: ASSERTION.to_owned(),
                    locations: vec![
                        "ios/UITests/DirectoryUITests.swift:42 in DirectoryUITests.waitUntilSaved(_:in:timeout:file:line:)".to_owned()
                    ],
                },
                Failure {
                    text: ALLOWANCE.to_owned(),
                    locations: Vec::new(),
                },
            ]
        );
        assert_eq!(evidence.errors.len(), 1);
        assert!(evidence.errors[0].starts_with("simulator log: xcrun refused simctl spawn"));
        assert!(bundle.is_dir());
        assert!(!kept.join("stale.json").exists());
        for file in [
            "summary.json",
            "details.json",
            "activities.json",
            "attachments/A.png",
            "attachments/manifest.json",
        ] {
            assert!(kept.join(file).is_file(), "{file} was not kept");
        }
        assert!(!kept.join(SIMULATOR_LOG).exists());
        let text = fs::read_to_string(kept.join("failure.json"))?;
        assert!(!text.contains(&root.display().to_string()));
        let report: Value = serde_json::from_str(&text)?;
        assert_eq!(report["result"], "Failed");
        assert_eq!(
            report["bundle"],
            format!("target/ios/ui-run/{NAME}.xcresult")
        );
        assert_eq!(report["failures"][0]["text"], ASSERTION);
        assert_eq!(
            report["attachments"],
            json!([{"name": "failure_0_ID.png", "file": "attachments/A.png", "failure": false}])
        );
        assert_eq!(
            report["timeline"],
            json!([
                {"at_seconds": 0.0, "seconds": 2.5, "step": "Start Test", "failure": false},
                {"at_seconds": 2.5, "seconds": 60.5, "step": "Wait up to 60.0 s until the saved directory enables the finish button", "failure": true},
                {"at_seconds": 63.0, "seconds": 7.0, "step": "Tear Down", "failure": false}
            ])
        );
        Ok(())
    }

    #[test]
    fn a_scenario_without_a_bundle_keeps_the_simulator_log_and_names_each_gap() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let root = directory.path();
        let bundle = root.join(format!("target/ios/ui-run/{NAME}.xcresult"));
        let tools = Forced {
            root: root.to_owned(),
            bundle: false,
            log: true,
        };
        let evidence = keep(&scenario(root, &bundle), &tools)?;
        assert!(evidence.failures.is_empty());
        assert_eq!(
            evidence
                .errors
                .iter()
                .map(|error| error.split(':').next().unwrap_or_default())
                .collect::<Vec<_>>(),
            ["summary", "test details", "activities", "attachments"]
        );
        let kept = root.join(EVIDENCE).join(NAME);
        assert_eq!(
            fs::read_to_string(kept.join(SIMULATOR_LOG))?,
            "\"launch denied by SpringBoard\""
        );
        let report: Value = serde_json::from_slice(&fs::read(kept.join("failure.json"))?)?;
        assert_eq!(report["export_errors"].as_array().map(Vec::len), Some(4));
        assert_eq!(report["failures"], json!([]));
        Ok(())
    }

    #[test]
    fn source_locations_outside_the_repository_keep_only_their_file_name() {
        let root = Path::new("/checkout");
        let summary = json!({"testFailures": [{"failureText": "failed"}]});
        let details = json!({"testRuns": [{"children": [
            {"name": "failed", "sourceLocation": {"filePath": "/elsewhere/home/Helper.swift", "lineNumber": 7}}
        ]}]});
        assert_eq!(
            failures(&summary, &details, root),
            [Failure {
                text: "failed".to_owned(),
                locations: vec!["Helper.swift:7".to_owned()],
            }]
        );
        assert_eq!(
            repository_path("/checkout/ios/UITests/A.swift", root),
            "ios/UITests/A.swift"
        );
    }
}
