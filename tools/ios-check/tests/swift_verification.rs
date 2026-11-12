//! Runs the `swift-verification` producer against a scripted Swift command.

use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    process::{Command, Output},
};

/// Absent until the producer exists, so every test here fails instead of failing to compile.
const PRODUCER: Option<&str> = option_env!("CARGO_BIN_EXE_swift-verification");
const VERSION: &str = "Apple Swift version 6.4.2 (scripted)\nTarget: arm64-apple-macosx15.0\n";
const LIST: &str =
    "PhonebookCoreTests.alpha()\nPhonebookKitTests.Suite/beta(value:)\nPhonebookKitTests.gamma()\n";
const ALPHA: &str = "PhonebookCoreTests.alpha()";
const BETA: &str = "PhonebookKitTests.Suite/beta(value:)";

/// What the scripted command prints and how it exits for each Swift invocation.
struct Script<'a> {
    version: (&'a str, i32),
    list: (&'a str, i32),
    run: (&'a str, i32),
}

impl Script<'_> {
    const fn passing(run: &str) -> Script<'_> {
        Script {
            version: (VERSION, 0),
            list: (LIST, 0),
            run: (run, 0),
        }
    }
}

struct Swift {
    directory: tempfile::TempDir,
}

impl Swift {
    fn new(script: &Script) -> Self {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let path = directory.path();
        fs::write(path.join("version"), script.version.0).expect("the version text");
        fs::write(path.join("list"), script.list.0).expect("the listing text");
        fs::write(path.join("run"), script.run.0).expect("the run text");
        let program = format!(
            "#!/bin/sh\nhere=$(dirname \"$0\")\ncase \"$1\" in\n  --version) cat \"$here/version\"; exit {} ;;\n  test)\n    if [ \"$2\" = list ]; then cat \"$here/list\"; exit {}; fi\n    printf '%s\\n' \"$@\" > \"$here/arguments\"\n    cat \"$here/run\"; exit {} ;;\nesac\nexit 64\n",
            script.version.1, script.list.1, script.run.1
        );
        let swift = path.join("swift");
        fs::write(&swift, program).expect("the scripted command");
        fs::set_permissions(&swift, fs::Permissions::from_mode(0o755))
            .expect("an executable script");
        Self { directory }
    }

    fn produce(&self, arguments: &[&str]) -> Output {
        self.command(arguments)
            .env("DOTFILES_VERIFICATION_SOURCE", "source-identity")
            .env("DOTFILES_VERIFICATION_PLAN", "plan-identity")
            .output()
            .expect("the producer starts")
    }

    fn command(&self, arguments: &[&str]) -> Command {
        let producer = PRODUCER.expect("the swift-verification binary exists");
        let mut command = Command::new(producer);
        command
            .env_remove("DOTFILES_VERIFICATION_SOURCE")
            .env_remove("DOTFILES_VERIFICATION_PLAN")
            .arg("--swift")
            .arg(self.directory.path().join("swift"))
            .args(arguments);
        command
    }

    fn arguments(&self) -> Vec<String> {
        fs::read_to_string(self.directory.path().join("arguments"))
            .expect("the recorded test arguments")
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn ran(&self) -> bool {
        self.directory.path().join("arguments").exists()
    }
}

fn report(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).expect("a JSON report on standard output")
}

fn outcome(name: &str, status: &str, counts: [u64; 4]) -> Value {
    let [executed, failed, skipped, inconclusive] = counts;
    json!({"name": name, "status": status, "executed": executed, "failed": failed, "skipped": skipped, "inconclusive": inconclusive})
}

fn refused(output: &Output) -> String {
    assert_eq!(
        output.status.code(),
        Some(2),
        "a refusal exits with status 2"
    );
    assert!(output.stdout.is_empty(), "a refusal prints no report");
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn reports_every_requested_test_that_passed() {
    let swift = Swift::new(&Script::passing(
        "◇ Test run started.\n✔ Test alpha() passed after 0.001 seconds.\n◇ Test case passing 1 argument value → 2 to beta(value:) started.\n✔ Test beta(value:) with 16 test cases passed after 0.002 seconds.\n✔ Test run with 2 tests in 1 suite passed after 0.003 seconds.\n",
    ));
    let output = swift.produce(&["--scope", "affected", BETA, ALPHA]);
    assert_eq!(output.status.code(), Some(0));
    let report = report(&output);
    assert_eq!(report["version"], 1);
    assert_eq!(report["source"], "source-identity");
    assert_eq!(report["plan"], "plan-identity");
    assert_eq!(report["method"], "test");
    assert_eq!(report["scope"], "affected");
    assert_eq!(
        report["tool_version"],
        "Apple Swift version 6.4.2 (scripted)"
    );
    assert!(
        !report["target"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .is_empty()
    );
    assert!(
        !report["bounds"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .is_empty()
    );
    assert_eq!(
        report["results"],
        json!([
            outcome(BETA, "passed", [1, 0, 0, 0]),
            outcome(ALPHA, "passed", [1, 0, 0, 0])
        ])
    );
}

#[test]
fn runs_only_the_requested_functions() {
    let swift = Swift::new(&Script::passing(
        "✔ Test alpha() passed after 0.001 seconds.\n✔ Test beta(value:) passed after 0.001 seconds.\n",
    ));
    let output = swift.produce(&["--scope", "affected", ALPHA, BETA]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        swift.arguments(),
        [
            "test",
            "--package-path",
            "apps/ios",
            "--filter",
            r"^(?:PhonebookCoreTests\.alpha\(\)|PhonebookKitTests\.Suite/beta\(value:\))(?:/|$)",
        ]
    );
}

#[test]
fn reports_a_failed_test_with_a_failing_status() {
    let swift = Swift::new(&Script {
        run: (
            "✔ Test alpha() passed after 0.001 seconds.\n✘ Test beta(value:) recorded an issue at Suite.swift:9:5: Expectation failed\n✘ Test beta(value:) failed after 0.002 seconds with 1 issue.\n",
            1,
        ),
        ..Script::passing("")
    });
    let output = swift.produce(&["--scope", "affected", ALPHA, BETA]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        report(&output)["results"],
        json!([
            outcome(ALPHA, "passed", [1, 0, 0, 0]),
            outcome(BETA, "failed", [1, 1, 0, 0])
        ])
    );
}

#[test]
fn reports_a_parameterized_failure_as_failed() {
    let swift = Swift::new(&Script {
        run: (
            "✔ Test alpha() with 1 test case passed after 0.001 seconds.\n✘ Test beta(value:) with 1 test case failed after 0.002 seconds with 1 issue.\n",
            1,
        ),
        ..Script::passing("")
    });
    let output = swift.produce(&["--scope", "affected", ALPHA, BETA]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        report(&output)["results"],
        json!([
            outcome(ALPHA, "passed", [1, 0, 0, 0]),
            outcome(BETA, "failed", [1, 1, 0, 0])
        ])
    );
}

#[test]
fn reads_the_result_line_after_issue_lines() {
    let swift = Swift::new(&Script::passing(
        "✘ Test alpha() recorded a known issue at Core.swift:4:3: Expectation failed\n✔ Test alpha() passed after 0.001 seconds with 1 known issue.\n",
    ));
    let output = swift.produce(&["--scope", "affected", ALPHA]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        report(&output)["results"],
        json!([outcome(ALPHA, "passed", [1, 0, 0, 0])])
    );
}

#[test]
fn carries_the_requested_full_scope() {
    let swift = Swift::new(&Script::passing(
        "✔ Test alpha() passed after 0.001 seconds.\n",
    ));
    let output = swift.produce(&["--scope", "full", ALPHA]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(report(&output)["scope"], "full");
}

#[test]
fn refuses_an_identifier_the_inventory_lacks() {
    let swift = Swift::new(&Script::passing(""));
    let message = refused(&swift.produce(&["--scope", "affected", "PhonebookCoreTests.delta()"]));
    assert!(message.contains("PhonebookCoreTests.delta()"), "{message}");
    assert!(!swift.ran());
}

#[test]
fn refuses_an_ambiguous_display_name() {
    let swift = Swift::new(&Script {
        list: (
            "PhonebookCoreTests.alpha()\nPhonebookKitTests.Suite/alpha()\n",
            0,
        ),
        ..Script::passing("")
    });
    let message = refused(&swift.produce(&["--scope", "affected", ALPHA]));
    assert!(message.contains("alpha()"), "{message}");
    assert!(!swift.ran());
}

#[test]
fn refuses_a_repeated_identifier() {
    let swift = Swift::new(&Script::passing(""));
    refused(&swift.produce(&["--scope", "affected", ALPHA, ALPHA]));
    assert!(!swift.ran());
}

#[test]
fn refuses_an_xctest_method() {
    let swift = Swift::new(&Script {
        list: (
            "PhonebookCoreTests.alpha()\nPhonebookKitTests.LegacyTests/testOld\n",
            0,
        ),
        ..Script::passing("")
    });
    let message = refused(&swift.produce(&[
        "--scope",
        "affected",
        "PhonebookKitTests.LegacyTests/testOld",
    ]));
    assert!(message.contains("Swift Testing function"), "{message}");
    assert!(!swift.ran());
}

#[test]
fn refuses_an_unknown_scope() {
    let swift = Swift::new(&Script::passing(""));
    refused(&swift.produce(&["--scope", "partial", ALPHA]));
    refused(&swift.produce(&[ALPHA]));
    refused(&swift.produce(&["--scope", "affected"]));
    assert!(!swift.ran());
}

#[test]
fn refuses_without_the_runner_identities() {
    let swift = Swift::new(&Script::passing(""));
    refused(
        &swift
            .command(&["--scope", "affected", ALPHA])
            .env("DOTFILES_VERIFICATION_PLAN", "plan-identity")
            .output()
            .expect("the producer starts"),
    );
    refused(
        &swift
            .command(&["--scope", "affected", ALPHA])
            .env("DOTFILES_VERIFICATION_SOURCE", "source-identity")
            .env("DOTFILES_VERIFICATION_PLAN", "")
            .output()
            .expect("the producer starts"),
    );
    assert!(!swift.ran());
}

#[test]
fn marks_a_missing_result_inconclusive() {
    let swift = Swift::new(&Script {
        run: (
            "✔ Test alpha() passed after 0.001 seconds.\n✔ Test alphabet() passed after 0.001 seconds.\nerror: Exited with unexpected signal code 11\n",
            1,
        ),
        ..Script::passing("")
    });
    let output = swift.produce(&["--scope", "affected", ALPHA, BETA]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        report(&output)["results"],
        json!([
            outcome(ALPHA, "passed", [1, 0, 0, 0]),
            outcome(BETA, "inconclusive", [0, 0, 0, 1])
        ])
    );
}

#[test]
fn reports_a_skipped_test_as_skipped() {
    let swift = Swift::new(&Script::passing(
        "➜ Test alpha() skipped: \"needs a device\"\n",
    ));
    let output = swift.produce(&["--scope", "affected", ALPHA]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        report(&output)["results"],
        json!([outcome(ALPHA, "skipped", [0, 0, 1, 0])])
    );
}

#[test]
fn stops_when_the_listing_fails() {
    let swift = Swift::new(&Script {
        list: ("error: build failed\n", 1),
        ..Script::passing("")
    });
    refused(&swift.produce(&["--scope", "affected", ALPHA]));
    assert!(!swift.ran());
}

#[test]
fn stops_when_the_toolchain_version_is_unavailable() {
    let swift = Swift::new(&Script {
        version: ("", 1),
        ..Script::passing("")
    });
    refused(&swift.produce(&["--scope", "affected", ALPHA]));
    let blank = Swift::new(&Script {
        version: ("\n", 0),
        ..Script::passing("")
    });
    refused(&blank.produce(&["--scope", "affected", ALPHA]));
    assert!(!swift.ran() && !blank.ran());
}
