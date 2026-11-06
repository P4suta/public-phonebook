//! Reports requested Swift package tests to the request-bound verification runner as structured JSON.

use anyhow::{Context, Result, ensure};
use clap::{Parser, ValueEnum};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    process::{Command, ExitCode, Output},
};

/// The Swift package that holds the tests, relative to the repository root where the runner starts.
const PACKAGE: &str = "ios";
const TARGET: &str = "Swift Testing functions of the ios package on the host macOS toolchain";
const BOUNDS: &str = "only the requested functions, selected through swift test --filter; no app, extension, or UI test execution";
const REGEX_SYNTAX: &str = r"\.+*?()|[]{}^$";

#[derive(Clone, Copy, ValueEnum)]
enum Scope {
    Affected,
    Full,
}

impl Scope {
    const fn name(self) -> &'static str {
        match self {
            Self::Affected => "affected",
            Self::Full => "full",
        }
    }
}

/// Runs the requested Swift Testing functions and prints one result for each identifier.
#[derive(Parser)]
struct Arguments {
    #[arg(long, value_enum)]
    scope: Scope,
    /// The Swift command to run instead of `xcrun swift`.
    #[arg(long)]
    swift: Option<PathBuf>,
    /// Identifiers as `swift test list` prints them, such as `PhonebookCoreTests.name()`.
    #[arg(required = true)]
    identifiers: Vec<String>,
}

#[derive(Clone, Copy)]
enum Status {
    Passed,
    Failed,
    Skipped,
    Inconclusive,
}

impl Status {
    /// The status name with its executed, failed, skipped, and inconclusive counts.
    const fn record(self) -> (&'static str, [u64; 4]) {
        match self {
            Self::Passed => ("passed", [1, 0, 0, 0]),
            Self::Failed => ("failed", [1, 1, 0, 0]),
            Self::Skipped => ("skipped", [0, 0, 1, 0]),
            Self::Inconclusive => ("inconclusive", [0, 0, 0, 1]),
        }
    }
}

fn main() -> ExitCode {
    let arguments = Arguments::parse();
    match produce(&arguments) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(error) => {
            eprintln!("swift-verification: {error:#}");
            ExitCode::from(2)
        }
    }
}

/// Prints the report and returns whether every requested test passed.
fn produce(arguments: &Arguments) -> Result<bool> {
    let source = identity("DOTFILES_VERIFICATION_SOURCE")?;
    let plan = identity("DOTFILES_VERIFICATION_PLAN")?;
    let version = succeeded(
        swift(arguments).arg("--version").output()?,
        "swift --version",
    )?;
    let version = version
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .context("swift --version printed no version")?
        .to_owned();
    let inventory = succeeded(
        swift(arguments)
            .args(["test", "list", "--package-path", PACKAGE])
            .output()?,
        "swift test list",
    )?;
    let names = requested(&arguments.identifiers, &inventory)?;
    let filter = format!(
        "^(?:{})(?:/|$)",
        arguments
            .identifiers
            .iter()
            .map(|identifier| escape(identifier))
            .collect::<Vec<_>>()
            .join("|")
    );
    let run = swift(arguments)
        .args(["test", "--package-path", PACKAGE, "--filter", &filter])
        .output()?;
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
    eprint!("{log}");
    let mut passed = true;
    let results: Vec<Value> = arguments
        .identifiers
        .iter()
        .zip(names)
        .map(|(identifier, name)| {
            let status = status(&log, name);
            passed &= matches!(status, Status::Passed);
            let (status, [executed, failed, skipped, inconclusive]) = status.record();
            json!({"name": identifier, "status": status, "executed": executed, "failed": failed, "skipped": skipped, "inconclusive": inconclusive})
        })
        .collect();
    println!(
        "{}",
        json!({"version": 1, "source": source, "plan": plan, "method": "test", "scope": arguments.scope.name(), "tool_version": version, "target": TARGET, "bounds": BOUNDS, "results": results})
    );
    Ok(passed)
}

fn identity(variable: &str) -> Result<String> {
    let value = std::env::var(variable).with_context(|| format!("{variable} is unset"))?;
    ensure!(!value.trim().is_empty(), "{variable} is empty");
    Ok(value)
}

fn swift(arguments: &Arguments) -> Command {
    if let Some(program) = &arguments.swift {
        return Command::new(program);
    }
    let mut command = Command::new("xcrun");
    command.arg("swift");
    command
}

fn succeeded(output: Output, step: &str) -> Result<String> {
    ensure!(
        output.status.success(),
        "{step} failed with {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(String::from_utf8(output.stdout)?)
}

/// The name that Swift Testing prints in result lines, without the module and any suites.
/// Only Swift Testing names end with their parameter list, unlike XCTest methods.
fn display(identifier: &str) -> Option<&str> {
    let (_, path) = identifier.split_once('.')?;
    let name = path.rsplit('/').next()?;
    name.ends_with(')').then_some(name)
}

/// Returns the display name of each identifier, which the inventory must list once under a unique display name.
fn requested<'a>(identifiers: &'a [String], inventory: &str) -> Result<Vec<&'a str>> {
    let listed: Vec<&str> = inventory.lines().map(str::trim).collect();
    let mut seen = BTreeSet::new();
    identifiers
        .iter()
        .map(|identifier| {
            ensure!(seen.insert(identifier), "{identifier} is requested twice");
            let name = display(identifier)
                .with_context(|| format!("{identifier} doesn't name a Swift Testing function"))?;
            ensure!(
                listed.iter().filter(|entry| **entry == identifier).count() == 1,
                "swift test list doesn't name {identifier} exactly once"
            );
            ensure!(
                listed
                    .iter()
                    .filter(|entry| display(entry) == Some(name))
                    .count()
                    == 1,
                "another listed test also prints as {name}, so its result line is ambiguous"
            );
            Ok(name)
        })
        .collect()
}

fn escape(identifier: &str) -> String {
    let mut pattern = String::new();
    for character in identifier.chars() {
        if REGEX_SYNTAX.contains(character) {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern
}

/// Reads the first result line for `name`; a test without one is inconclusive.
fn status(log: &str, name: &str) -> Status {
    let passed = format!("✔ Test {name} ");
    let failed = format!("✘ Test {name} ");
    let skipped = format!("➜ Test {name} skipped");
    log.lines()
        .find_map(|line| {
            if line
                .strip_prefix(&passed)
                .is_some_and(|rest| ends(rest, "passed after "))
            {
                Some(Status::Passed)
            } else if line
                .strip_prefix(&failed)
                .is_some_and(|rest| ends(rest, "failed after "))
            {
                Some(Status::Failed)
            } else if line.starts_with(&skipped) {
                Some(Status::Skipped)
            } else {
                None
            }
        })
        .unwrap_or(Status::Inconclusive)
}

/// Whether `rest` reads `outcome`, directly or after the `with N test cases` count of a parameterized test.
fn ends(rest: &str, outcome: &str) -> bool {
    let rest = rest
        .strip_prefix("with ")
        .and_then(|counted| {
            let (count, tail) = counted.split_once(' ')?;
            count.parse::<u64>().ok()?;
            tail.strip_prefix("test cases ")
                .or_else(|| tail.strip_prefix("test case "))
        })
        .unwrap_or(rest);
    rest.starts_with(outcome)
}
