//! Adds up each logged step's wall time, retired instructions, and work counters for the gate's report; no verdict reads them.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::io;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use step_meter::ChildUsage;

const MILLISECONDS_PER_SECOND: f64 = 1000.0;
const INSTRUCTIONS_PER_BILLION: f64 = 1e9;
const STEP_COLUMN: usize = 52;
const RUNS_COLUMN: usize = 6;
const SECONDS_COLUMN: usize = 10;
const INSTRUCTIONS_COLUMN: usize = 14;

#[derive(Default)]
struct Totals {
    runs: u64,
    elapsed: Duration,
    instructions: u64,
    counted: bool,
    gaps: BTreeSet<String>,
    work: BTreeMap<String, u64>,
}

static STEPS: Mutex<Vec<(String, Totals)>> = Mutex::new(Vec::new());

/// Where a command hands its work, outside every process that the meter counts.
fn delegated(program: &str, first: Option<&str>) -> Option<&'static str> {
    match (program, first) {
        ("docker" | "dotfiles", _) => Some("the container VM"),
        ("xcodebuild", _) => Some("Xcode's build service"),
        ("xcrun", Some("simctl")) => Some("CoreSimulator"),
        _ => None,
    }
}

/// The step's record of one finished process, kept apart from the store so tests can check it.
fn add(
    totals: &mut Totals,
    program: &str,
    first: Option<&str>,
    elapsed: Duration,
    usage: &io::Result<ChildUsage>,
    work: &[(&str, u64)],
) {
    totals.runs += 1;
    totals.elapsed += elapsed;
    *totals.work.entry("processes".to_owned()).or_default() += 1;
    for (name, amount) in work {
        *totals.work.entry((*name).to_owned()).or_default() += amount;
    }
    match usage {
        Ok(usage) => {
            totals.counted = true;
            totals.instructions += usage.instructions;
            if usage.reaped_descendants {
                totals.gaps.insert(format!("{program}: forked processes"));
            }
        }
        Err(_) => {
            totals.gaps.insert(format!("{program}: no count"));
        }
    }
    if let Some(place) = delegated(program, first) {
        totals.gaps.insert(format!("{program}: work in {place}"));
    }
}

fn record(
    name: &str,
    command: &Command,
    elapsed: Duration,
    usage: &io::Result<ChildUsage>,
    work: &[(&str, u64)],
) {
    let program = Path::new(command.get_program())
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("command")
        .to_owned();
    let first = command.get_args().next().and_then(OsStr::to_str);
    let Ok(mut steps) = STEPS.lock() else {
        return;
    };
    let index = steps
        .iter()
        .position(|(step, _)| step == name)
        .unwrap_or_else(|| {
            steps.push((name.to_owned(), Totals::default()));
            steps.len() - 1
        });
    add(&mut steps[index].1, &program, first, elapsed, usage, work);
}

/// Runs `command` like `Command::output` and adds its time, count, and `work` to the step `name`.
pub fn measured_output(name: &str, command: &mut Command, work: &[(&str, u64)]) -> Result<Output> {
    let started = Instant::now();
    let (output, usage) =
        step_meter::output_measured(command).with_context(|| format!("Start {name}"))?;
    record(name, command, started.elapsed(), &usage, work);
    Ok(output)
}

fn step_json(name: &str, totals: &Totals) -> Value {
    let coverage = if !totals.counted {
        "unmeasured"
    } else if totals.gaps.is_empty() {
        "complete"
    } else {
        "partial"
    };
    json!({
        "step": name,
        "runs": totals.runs,
        "ms": totals.elapsed.as_millis(),
        "instructions": totals.counted.then_some(totals.instructions),
        "coverage": coverage,
        "gaps": if totals.counted { totals.gaps.iter().collect::<Vec<_>>() } else { Vec::new() },
        "work": totals.work,
    })
}

/// The JSON report of every recorded step and the checker's own retired instructions.
pub fn report(own: io::Result<u64>) -> Value {
    let steps = STEPS
        .lock()
        .map(|steps| {
            steps
                .iter()
                .map(|(name, totals)| step_json(name, totals))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({"operation":"ios-check.steps", "ownInstructions": own.ok(), "steps": steps})
}

/// Formats the report's steps as a table for standard error.
pub fn table(report: &Value) -> String {
    let mut lines = vec![format!(
        "{:<STEP_COLUMN$}{:>RUNS_COLUMN$}{:>SECONDS_COLUMN$}{:>INSTRUCTIONS_COLUMN$}",
        "iOS step", "runs", "seconds", "Ginstructions"
    )];
    for step in report["steps"].as_array().into_iter().flatten() {
        let seconds = step["ms"].as_f64().unwrap_or_default() / MILLISECONDS_PER_SECOND;
        let instructions = step["instructions"].as_f64().map_or_else(
            || "-".to_owned(),
            |count| {
                let suffix = if step["coverage"] == "complete" {
                    ""
                } else {
                    "+"
                };
                format!("{:.2}{suffix}", count / INSTRUCTIONS_PER_BILLION)
            },
        );
        lines.push(format!(
            "{:<STEP_COLUMN$}{:>RUNS_COLUMN$}{seconds:>SECONDS_COLUMN$.1}{instructions:>INSTRUCTIONS_COLUMN$}",
            step["step"].as_str().unwrap_or_default(),
            step["runs"]
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const COUNTED: u64 = 1_000;
    const SECOND_COUNTED: u64 = 500;

    fn counted(instructions: u64, reaped_descendants: bool) -> io::Result<ChildUsage> {
        Ok(ChildUsage {
            instructions,
            reaped_descendants,
        })
    }

    #[test]
    fn a_step_is_complete_only_without_forks_delegation_or_missing_counts() {
        let mut lean = Totals::default();
        add(
            &mut lean,
            "lean",
            None,
            Duration::ZERO,
            &counted(COUNTED, false),
            &[("lean compiles", 1)],
        );
        let lean = step_json("lean", &lean);
        assert_eq!(lean["coverage"], "complete");
        assert_eq!(lean["instructions"], COUNTED);
        assert_eq!(lean["work"], json!({"lean compiles": 1, "processes": 1}));

        let mut replay = Totals::default();
        add(
            &mut replay,
            "dotfiles",
            Some("bounded"),
            Duration::ZERO,
            &counted(COUNTED, true),
            &[],
        );
        add(
            &mut replay,
            "swift",
            None,
            Duration::ZERO,
            &Err(io::ErrorKind::Unsupported.into()),
            &[],
        );
        let replay = step_json("replay", &replay);
        assert_eq!(replay["coverage"], "partial");
        assert_eq!(
            replay["gaps"],
            json!([
                "dotfiles: forked processes",
                "dotfiles: work in the container VM",
                "swift: no count"
            ])
        );

        let mut simulator = Totals::default();
        add(
            &mut simulator,
            "xcrun",
            Some("simctl"),
            Duration::ZERO,
            &counted(SECOND_COUNTED, false),
            &[],
        );
        assert_eq!(
            step_json("boot", &simulator)["gaps"],
            json!(["xcrun: work in CoreSimulator"])
        );

        let mut unmeasured = Totals::default();
        add(
            &mut unmeasured,
            "lean",
            None,
            Duration::ZERO,
            &Err(io::ErrorKind::Unsupported.into()),
            &[],
        );
        let unmeasured = step_json("lean", &unmeasured);
        assert_eq!(unmeasured["coverage"], "unmeasured");
        assert_eq!(unmeasured["instructions"], Value::Null);
        assert_eq!(unmeasured["gaps"], json!([]));
    }

    #[test]
    fn repeated_runs_add_up_and_the_table_marks_partial_counts() {
        let mut totals = Totals::default();
        add(
            &mut totals,
            "lean",
            None,
            Duration::from_millis(1500),
            &counted(2_500_000_000, false),
            &[],
        );
        add(
            &mut totals,
            "lean",
            None,
            Duration::from_millis(500),
            &counted(SECOND_COUNTED, true),
            &[],
        );
        let step = step_json("lean-WaitDisplay", &totals);
        assert_eq!(step["runs"], 2);
        assert_eq!(step["instructions"], 2_500_000_000 + SECOND_COUNTED);
        let table = table(&json!({"steps": [step]}));
        assert!(table.lines().nth(1).is_some_and(
            |row| row.starts_with("lean-WaitDisplay") && row.ends_with("2.0         2.50+")
        ));
    }
}
