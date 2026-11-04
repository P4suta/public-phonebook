use super::{logged, require_current_sources, source_hashes, source_records};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

/// A profile's temporary directory holds at most this much at once; one unmutated package build takes 118 MiB.
const SCRATCH_BUDGET_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// How often the gate samples the size of a profile's temporary directory.
const SCRATCH_SAMPLE_INTERVAL: Duration = Duration::from_millis(500);
/// What macOS reports for a write past a test process's file size cap, which `testDirectory` sets and turns from a signal into an error.
/// A cap on the tool's whole process tree stops its sandbox build even at 4 GiB, so the core tests carry it.
const FILE_LIMIT_ERROR: &str = "File too large";

const VERSION: &str = "1.6.4";
/// The pinned tool limits each mutant's test run in wall-clock seconds and offers no CPU-time limit.
/// The guard is a multiple of the unmutated run, so only a hang reaches it, and it never drops below the floor.
const GUARD_FACTOR: u32 = 5;
const GUARD_FLOOR: Duration = Duration::from_secs(20);
const OPERATORS: [&str; 7] = [
    "RelationalOperatorReplacement",
    "BooleanLiteralReplacement",
    "LogicalOperatorReplacement",
    "ArithmeticOperatorReplacement",
    "NegateConditional",
    "SwapTernary",
    "RemoveSideEffects",
];

/// The `<` declarations of `Comparable` types, by file and type, whose renamed operator the compiler must reject.
const DECLARATIONS: [(&str, &str); 2] = [
    ("Sources/PhonebookCore/Contracts.swift", "PrefectureCode"),
    ("Sources/PhonebookCore/SearchInput.swift", "NameRank"),
];

/// A mutant that can't change any result, named by its file, its trimmed source line, and its operation.
/// An edited line no longer matches, so its mutant returns as a survivor until someone reviews it again.
struct Equivalent {
    file: &'static str,
    line: &'static str,
    operator: &'static str,
    original: &'static str,
    replacement: &'static str,
    reason: &'static str,
}

const EQUIVALENTS: [Equivalent; 4] = [
    Equivalent {
        file: "Sources/PhonebookCore/CallerFile.swift",
        line: "buffer.removeAll(keepingCapacity: true)",
        operator: "BooleanLiteralReplacement",
        original: "true",
        replacement: "false",
        reason: "Keeping the capacity only spares a reallocation; no written byte, record, or count depends on it.",
    },
    Equivalent {
        file: "Sources/PhonebookCore/CallerFile.swift",
        line: "guard buffer.count - position < bytes, !ended else { return }",
        operator: "RelationalOperatorReplacement",
        original: "<",
        replacement: "<=",
        reason: "With exactly `bytes` unread, the extra pass moves the unread bytes to the front and reads nothing, because its loop needs fewer than `bytes`.",
    },
    Equivalent {
        file: "Sources/PhonebookCore/CallerFile.swift",
        line: "while buffer.count < bytes, !ended {",
        operator: "RelationalOperatorReplacement",
        original: "<",
        replacement: "<=",
        reason: "A refill keeps at least one unread byte because every record is shorter than maximumRecordBytes, and each read adds at least that many, so the buffer holds exactly `bytes` only at the end of the file, where one more read returns nothing.",
    },
    Equivalent {
        file: "Sources/PhonebookCore/CallerFile.swift",
        line: "ended = true",
        operator: "BooleanLiteralReplacement",
        original: "true",
        replacement: "false",
        reason: "At the end of the file every further read returns nothing as well, so the flag only saves those reads.",
    },
];

#[derive(Debug, Default, PartialEq)]
struct Counts {
    killed: usize,
    /// Mutants whose activated code ended the test process, which the tool records as a crash.
    crashed: usize,
    compiler_rejected: usize,
    /// Survivors that `EQUIVALENTS` explains, as file, line, and operation.
    equivalent: Vec<String>,
    /// Mutants that reached the hang guard, about which the run holds no evidence.
    inconclusive: Vec<String>,
    /// Mutants whose tests stopped at the file size cap, which proves nothing about the mutant.
    resource_stopped: Vec<String>,
}

/// The bytes of every regular file under `path`, skipping entries that vanish while the build churns.
fn tree_bytes(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => tree_bytes(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map_or(0, |data| data.len()),
            _ => 0,
        })
        .sum()
}

/// Samples the size of `path` at each interval until `done` turns true, and returns the largest sample.
fn sample_peak(path: PathBuf, done: Arc<AtomicBool>) -> thread::JoinHandle<u64> {
    thread::spawn(move || {
        let mut peak = 0;
        loop {
            peak = peak.max(tree_bytes(&path));
            if done.load(Ordering::Relaxed) {
                return peak;
            }
            thread::sleep(SCRATCH_SAMPLE_INTERVAL);
        }
    })
}

/// Reads the kept log of one mutant after checking that its identity names a log file.
fn mutant_log(logs: &Path, mutant: &Value) -> Result<String> {
    let id = mutant["id"]
        .as_str()
        .context("Missing mutant log identity")?;
    ensure!(
        id.strip_prefix("swift-mutation-testing_").is_some_and(
            |suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
        ),
        "Invalid mutation log name"
    );
    Ok(fs::read_to_string(logs.join(format!("{id}.log")))?)
}

/// The trimmed text of a planned mutant's source line.
fn source_line(root: &Path, planned: &Value) -> Option<String> {
    let line = usize::try_from(planned["line"].as_u64()?).ok()?;
    let source = fs::read_to_string(root.join("ios").join(planned["file"].as_str()?)).ok()?;
    source
        .lines()
        .nth(line.checked_sub(1)?)
        .map(|text| text.trim().to_owned())
}

fn matches(equivalent: &Equivalent, planned: &Value, line: Option<&str>) -> bool {
    planned["file"] == equivalent.file
        && planned["operator"] == equivalent.operator
        && planned["original"] == equivalent.original
        && planned["replacement"] == equivalent.replacement
        && line == Some(equivalent.line)
}

/// The hang guard in whole seconds, rounded up.
fn hang_guard(baseline: Duration) -> u64 {
    let guard = (baseline * GUARD_FACTOR).max(GUARD_FLOOR);
    guard.as_secs() + u64::from(guard.subsec_nanos() > 0)
}

/// Builds the tests, then times one unmutated run of the profile's test target.
fn baseline(root: &Path, name: &str, target: &str) -> Result<Duration> {
    logged(
        root,
        &format!("mutation-{name}-baseline-build"),
        Command::new("xcrun").current_dir(root).args([
            "swift",
            "build",
            "--package-path",
            "ios",
            "--build-tests",
        ]),
    )?;
    let started = Instant::now();
    logged(
        root,
        &format!("mutation-{name}-baseline"),
        Command::new("xcrun").current_dir(root).args([
            "swift",
            "test",
            "--package-path",
            "ios",
            "--skip-build",
            "--filter",
            &format!("^{target}\\."),
        ]),
    )?;
    Ok(started.elapsed())
}

fn declaration_rejection(root: &Path, mutant: &Value, log: &str) -> bool {
    let Some((file, kind)) = DECLARATIONS
        .iter()
        .find(|(file, _)| mutant["file"] == *file)
    else {
        return false;
    };
    if mutant["operator"] != "RelationalOperatorReplacement"
        || mutant["replacementKind"] != "binaryOperator"
        || mutant["original"] != "<"
        || !matches!(mutant["replacement"].as_str(), Some("<=" | ">"))
        || mutant["schematizable"] != false
        || !log.contains(&format!(
            "type '{kind}' does not conform to protocol 'Comparable'"
        ))
        || !log.contains("protocol requires function '<'")
    {
        return false;
    }
    let Ok(source) = fs::read_to_string(root.join("ios").join(file)) else {
        return false;
    };
    let Some(start) = mutant["utf8Start"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
    else {
        return false;
    };
    let Some(end) = mutant["utf8End"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
    else {
        return false;
    };
    source.get(start..end) == Some("<")
        && source
            .get(..start)
            .is_some_and(|prefix| prefix.ends_with("public static func "))
        && source
            .get(end..)
            .is_some_and(|suffix| suffix.starts_with(" (lhs: Self, rhs: Self) -> Bool"))
}

fn results(
    root: &Path,
    plan: &Value,
    report: &Value,
    plan_hash: &str,
    logs: &Path,
    equivalents: &[Equivalent],
) -> Result<Counts> {
    ensure!(
        plan["formatVersion"] == 1
            && plan["toolVersion"] == VERSION
            && report["config"]["toolVersion"] == VERSION
            && report["config"]["planSha256"] == plan_hash,
        "Mutation report identity does not match its plan and pinned tool"
    );
    let operators = plan["scope"]["operators"]
        .as_array()
        .context("Missing mutation operators")?;
    ensure!(
        operators.len() == OPERATORS.len()
            && operators
                .iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>()
                == OPERATORS.into_iter().collect(),
        "The mutation plan must include all seven operators"
    );
    ensure!(
        plan["scope"]["excludePatterns"]
            .as_array()
            .is_some_and(Vec::is_empty),
        "The mutation plan excludes inputs"
    );
    let mut expected = BTreeMap::new();
    for mutant in plan["mutants"]
        .as_array()
        .context("Missing planned mutants")?
    {
        let fingerprint = mutant["fingerprint"]
            .as_str()
            .context("Missing mutant identity")?;
        ensure!(
            expected.insert(fingerprint, mutant).is_none(),
            "Duplicate planned mutant"
        );
    }
    ensure!(!expected.is_empty(), "The mutation plan is empty");
    // Each entry for a planned file names exactly one planned mutant, so a moved or killed one never hides another.
    let mut explained = BTreeMap::new();
    for (index, equivalent) in equivalents.iter().enumerate() {
        if !expected
            .values()
            .any(|planned| planned["file"] == equivalent.file)
        {
            continue;
        }
        let named = expected
            .iter()
            .filter(|(_, planned)| {
                matches(equivalent, planned, source_line(root, planned).as_deref())
            })
            .map(|(fingerprint, _)| *fingerprint)
            .collect::<Vec<_>>();
        ensure!(
            named.len() == 1,
            "The equivalent mutant at {} `{}` names {} planned mutants instead of one",
            equivalent.file,
            equivalent.line,
            named.len()
        );
        explained.insert(named[0], index);
    }
    let mut observed = BTreeSet::new();
    let mut counts = Counts::default();
    for (file, value) in report["files"]
        .as_object()
        .context("Missing mutation results")?
    {
        for mutant in value["mutants"]
            .as_array()
            .context("Missing file mutation results")?
        {
            let fingerprint = mutant["fingerprint"]
                .as_str()
                .context("Missing result identity")?;
            let planned = expected
                .get(fingerprint)
                .context("Unexpected mutant result")?;
            ensure!(observed.insert(fingerprint), "Duplicate mutant result");
            ensure!(
                Some(file.trim_start_matches('/')) == planned["file"].as_str()
                    && mutant["mutatorName"] == planned["operator"]
                    && mutant["originalText"] == planned["original"]
                    && mutant["replacement"] == planned["replacement"]
                    && mutant["location"]["start"]["line"] == planned["line"]
                    && mutant["location"]["start"]["column"] == planned["column"],
                "Mutation result differs from its planned operation"
            );
            if let Some(index) = explained.get(fingerprint) {
                ensure!(
                    mutant["status"] == "Survived",
                    "An equivalent mutant is {}, so its entry no longer holds",
                    mutant["status"]
                );
                let equivalent = &equivalents[*index];
                counts.equivalent.push(format!(
                    "{}:{} {} {} -> {}: {}",
                    equivalent.file,
                    planned["line"],
                    equivalent.operator,
                    equivalent.original,
                    equivalent.replacement,
                    equivalent.reason
                ));
                continue;
            }
            if mutant["status"] == "Killed" && mutant_log(logs, mutant)?.contains(FILE_LIMIT_ERROR)
            {
                counts.resource_stopped.push(fingerprint.to_owned());
                continue;
            }
            match mutant["status"].as_str() {
                Some("Killed") if mutant["statusReason"] == "crash" => {
                    ensure!(
                        mutant["activated"] == true
                            && mutant_log(logs, mutant)?.lines().any(|line| {
                                line.strip_prefix("status:")
                                    .is_some_and(|status| status.trim() == "Crash")
                            }),
                        "A crashed mutant lacks activation and the tool's crash record"
                    );
                    counts.crashed += 1;
                }
                Some("Killed") => {
                    ensure!(
                        mutant["activated"] == true
                            && mutant["killedBy"]
                                .as_array()
                                .is_some_and(|tests| !tests.is_empty()
                                    && tests.iter().all(|test| test
                                        .as_str()
                                        .is_some_and(|name| !name.is_empty()))),
                        "A killed mutant lacks activation and failing-test evidence"
                    );
                    counts.killed += 1;
                }
                Some("CompileError") => {
                    let log = mutant_log(logs, mutant)?;
                    ensure!(
                        declaration_rejection(root, planned, &log),
                        "An unexplained mutation build failure supplies no test evidence"
                    );
                    counts.compiler_rejected += 1;
                }
                Some("Timeout") => counts.inconclusive.push(fingerprint.to_owned()),
                status => anyhow::bail!(
                    "Mutation {fingerprint} is {status:?}; a survivor or uncovered mutant cannot pass"
                ),
            }
        }
    }
    ensure!(
        observed.len() == expected.len()
            && (counts.killed + counts.crashed > 0
                || !counts.inconclusive.is_empty()
                || !counts.resource_stopped.is_empty()),
        "The mutation result inventory is incomplete or unexecuted"
    );
    Ok(counts)
}

pub fn run(root: &Path) -> Result<()> {
    let receipt = root.join("target/ios/mutation-receipt.json");
    if receipt.exists() {
        fs::remove_file(&receipt)?;
    }
    let sources = source_hashes(root)?;
    let version = logged(
        root,
        "mutation-version",
        Command::new("swift-mutation-testing").arg("--version"),
    )?;
    ensure!(
        String::from_utf8_lossy(&version.stdout)
            .starts_with(&format!("swift-mutation-testing {VERSION} [")),
        "The Swift mutation tool differs from the project pin"
    );
    let directory = tempfile::Builder::new()
        .prefix("mutation-")
        .tempdir_in(root.join("target/ios"))?
        .keep();
    let mut profiles = Vec::new();
    let mut inconclusive = Vec::new();
    for (name, source, target) in [
        ("core", "Sources/PhonebookCore", "PhonebookCoreTests"),
        (
            "notifications",
            "Sources/PhonebookKit/ExtensionNotifications.swift",
            "PhonebookKitTests",
        ),
    ] {
        let plan_path = directory.join(format!("{name}-plan.json"));
        let report_path = directory.join(format!("{name}-result.json"));
        let logs = directory.join(format!("{name}-logs"));
        logged(
            root,
            &format!("mutation-{name}-plan"),
            Command::new("swift-mutation-testing")
                .current_dir(root.join("ios"))
                .args([
                    "plan",
                    ".",
                    "--target",
                    target,
                    "--sources-path",
                    source,
                    "--operator-tier",
                    "experimental",
                    "--output",
                ])
                .arg(&plan_path),
        )?;
        let plan_bytes = fs::read(&plan_path)?;
        let plan: Value = serde_json::from_slice(&plan_bytes)?;
        ensure!(
            plan["project"]["type"] == "spm"
                && plan["project"]["testTarget"] == target
                && plan["scope"]["sourcesPath"] == source,
            "The mutation plan has an unexpected target or source scope"
        );
        let measured = baseline(root, name, target)?;
        let guard = hang_guard(measured);
        // The tool and every test process it starts write their temporary files here, and dropping it removes them on every exit path.
        let scratch = tempfile::Builder::new()
            .prefix(&format!("{name}-tmp-"))
            .tempdir_in(&directory)?;
        let done = Arc::new(AtomicBool::new(false));
        let sampler = sample_peak(scratch.path().to_owned(), Arc::clone(&done));
        let run = logged(
            root,
            &format!("mutation-{name}"),
            Command::new("swift-mutation-testing")
                .current_dir(root.join("ios"))
                .env("TMPDIR", scratch.path())
                .args(["run", ".", "--plan"])
                .arg(&plan_path)
                .args(["--concurrency", "1", "--timeout"])
                .arg(guard.to_string())
                // The gate, not the tool's score, decides survivors, because a listed equivalent counts against that score.
                .args([
                    "--build-timeout",
                    "120",
                    "--no-cache",
                    "--max-integrity-warnings",
                    "0",
                    "--output",
                ])
                .arg(&report_path)
                .arg("--keep-logs")
                .arg(&logs),
        );
        done.store(true, Ordering::Relaxed);
        let peak = sampler
            .join()
            .map_err(|_| anyhow::anyhow!("The scratch size sampler stopped"))?;
        drop(scratch);
        ensure!(
            peak <= SCRATCH_BUDGET_BYTES,
            "INCONCLUSIVE: the {name} profile's temporary files reached {peak} bytes, past the {SCRATCH_BUDGET_BYTES}-byte budget, so the run stopped on a resource rather than on a test"
        );
        run?;
        let hash = crate::sha256_hex(plan_bytes);
        let counts = results(
            root,
            &plan,
            &serde_json::from_slice(&fs::read(&report_path)?)?,
            &hash,
            &logs,
            &EQUIVALENTS,
        )?;
        profiles.push(json!({"scope":source,"target":target,"plan":plan_path,"report":report_path,"plan_sha256":hash,"baseline_seconds":measured.as_secs_f64(),"hang_guard_seconds":guard,"killed":counts.killed,"crashed":counts.crashed,"compiler_rejected_declaration_renames":counts.compiler_rejected,"equivalent":counts.equivalent,"survived":0,"uncovered":0,"inconclusive_timeouts":counts.inconclusive,"resource_stopped":counts.resource_stopped,"test_file_limit":"the core tests cap their own process at 256 MiB, far over the 15.3 MB largest file of an unmutated build","scratch_budget_bytes":SCRATCH_BUDGET_BYTES,"scratch_peak_bytes":peak}));
        inconclusive.extend(counts.inconclusive);
        inconclusive.extend(counts.resource_stopped);
    }
    require_current_sources(root, &sources)?;
    let result = if inconclusive.is_empty() {
        "passed"
    } else {
        "inconclusive"
    };
    fs::write(
        receipt,
        serde_json::to_vec_pretty(
            &json!({"result":result,"tool":"swift-mutation-testing","version":VERSION,"workers":1,"operators":OPERATORS,"hang_guard":format!("{GUARD_FACTOR} times the unmutated test run, at least {} s, in wall-clock time because the tool has no CPU-time limit", GUARD_FLOOR.as_secs()),"profiles":profiles,"source_sha256":source_records(&sources),"scope_limit":"pure core and extension notification policy; not every application or framework path","compiler_rejection":"Only source-checked renames of the required Comparable operator with the matching compiler diagnostic; never counted as killed"}),
        )?,
    )?;
    ensure!(
        inconclusive.is_empty(),
        "INCONCLUSIVE: {} mutants reached the hang guard or the file size cap, so the gate holds no evidence about them: {}",
        inconclusive.len(),
        inconclusive.join(", ")
    );
    println!(
        "PASS: source-bound Swift mutation gate; {}",
        directory.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiler_rejections_require_the_exact_operator_declaration_and_diagnostic() -> Result<()> {
        let root = tempfile::tempdir()?;
        let path = root.path().join("ios/Sources/PhonebookCore");
        fs::create_dir_all(&path)?;
        let source =
            "public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }";
        fs::write(path.join("Contracts.swift"), source)?;
        let start = source.find('<').context("Missing declaration")?;
        let mutant = json!({"file":"Sources/PhonebookCore/Contracts.swift","operator":"RelationalOperatorReplacement","replacementKind":"binaryOperator","original":"<","replacement":"<=","schematizable":false,"utf8Start":start,"utf8End":start+1});
        let diagnostic = "type 'PrefectureCode' does not conform to protocol 'Comparable'\nprotocol requires function '<'";
        assert!(declaration_rejection(root.path(), &mutant, diagnostic));
        assert!(!declaration_rejection(
            root.path(),
            &mutant,
            "Build timed out"
        ));
        let mut body = mutant.clone();
        let start = source.rfind('<').context("Missing body expression")?;
        body["utf8Start"] = json!(start);
        body["utf8End"] = json!(start + 1);
        assert!(!declaration_rejection(root.path(), &body, diagnostic));
        let mut unknown = mutant.clone();
        unknown["replacement"] = json!("!=");
        assert!(!declaration_rejection(root.path(), &unknown, diagnostic));
        fs::write(path.join("SearchInput.swift"), source)?;
        let mut rank = mutant.clone();
        rank["file"] = json!("Sources/PhonebookCore/SearchInput.swift");
        assert!(!declaration_rejection(root.path(), &rank, diagnostic));
        let named = "type 'NameRank' does not conform to protocol 'Comparable'\nprotocol requires function '<'";
        assert!(declaration_rejection(root.path(), &rank, named));
        let mut other = mutant;
        other["file"] = json!("Sources/PhonebookCore/Other.swift");
        fs::write(path.join("Other.swift"), source)?;
        assert!(!declaration_rejection(root.path(), &other, named));
        Ok(())
    }

    #[test]
    fn an_equivalent_entry_explains_exactly_its_own_surviving_mutant() -> Result<()> {
        let root = tempfile::tempdir()?;
        fs::create_dir_all(root.path().join("ios/Sources"))?;
        let source = root.path().join("ios/Sources/Example.swift");
        fs::write(&source, "  ready = true\n  done = true\n")?;
        fs::write(
            root.path().join("swift-mutation-testing_1.log"),
            "status:    Killed\n",
        )?;
        let entry = [Equivalent {
            file: "Sources/Example.swift",
            line: "ready = true",
            operator: "BooleanLiteralReplacement",
            original: "true",
            replacement: "false",
            reason: "The flag only saves work.",
        }];
        let planned = |fingerprint: &str, line: u64| json!({"fingerprint":fingerprint,"file":"Sources/Example.swift","operator":"BooleanLiteralReplacement","original":"true","replacement":"false","line":line,"column":11});
        let result = |fingerprint: &str, line: u64, status: &str| json!({"fingerprint":fingerprint,"id":"swift-mutation-testing_1","mutatorName":"BooleanLiteralReplacement","originalText":"true","replacement":"false","location":{"start":{"line":line,"column":11}},"status":status,"activated":true,"killedBy":["contract()"]});
        let plan = json!({"formatVersion":1,"toolVersion":VERSION,"scope":{"operators":OPERATORS,"excludePatterns":[]},"mutants":[planned("flag", 1), planned("done", 2)]});
        let report = |first: &str, second: &str| json!({"config":{"toolVersion":VERSION,"planSha256":"hash"},"files":{"/Sources/Example.swift":{"mutants":[result("flag", 1, first), result("done", 2, second)]}}});
        let counts = results(
            root.path(),
            &plan,
            &report("Survived", "Killed"),
            "hash",
            root.path(),
            &entry,
        )?;
        assert_eq!(counts.killed, 1);
        assert_eq!(
            counts.equivalent,
            [
                "Sources/Example.swift:1 BooleanLiteralReplacement true -> false: The flag only saves work."
            ]
        );
        // The planted survivor on the other line stays a failure.
        assert!(
            results(
                root.path(),
                &plan,
                &report("Survived", "Survived"),
                "hash",
                root.path(),
                &entry
            )
            .is_err()
        );
        // A killed mutant shows that its entry no longer holds.
        assert!(
            results(
                root.path(),
                &plan,
                &report("Killed", "Killed"),
                "hash",
                root.path(),
                &entry
            )
            .is_err()
        );
        // An edited line names no mutant, so the entry fails until someone reviews it.
        fs::write(&source, "  ready = !false\n  done = true\n")?;
        assert!(
            results(
                root.path(),
                &plan,
                &report("Survived", "Killed"),
                "hash",
                root.path(),
                &entry
            )
            .is_err()
        );
        Ok(())
    }

    #[test]
    fn mutation_receipts_reject_missing_duplicate_unactivated_and_non_killed_cases() -> Result<()> {
        let root = tempfile::tempdir()?;
        let planned = json!({"fingerprint":"one","file":"Sources/Example.swift","operator":"NegateConditional","original":"ready","replacement":"!ready","line":1,"column":1});
        let plan = json!({"formatVersion":1,"toolVersion":VERSION,"scope":{"operators":OPERATORS,"excludePatterns":[]},"mutants":[planned]});
        let mutant = json!({"fingerprint":"one","id":"swift-mutation-testing_0","mutatorName":"NegateConditional","originalText":"ready","replacement":"!ready","location":{"start":{"line":1,"column":1}},"status":"Killed","activated":true,"killedBy":["contract()"]});
        let report = json!({"config":{"toolVersion":VERSION,"planSha256":"hash"},"files":{"/Sources/Example.swift":{"mutants":[mutant.clone()]}}});
        let log = root.path().join("swift-mutation-testing_0.log");
        fs::write(
            &log,
            "mutant:    swift-mutation-testing_0\nstatus:    Killed\n",
        )?;
        assert_eq!(
            results(root.path(), &plan, &report, "hash", root.path(), &[])?,
            Counts {
                killed: 1,
                ..Counts::default()
            }
        );
        let mut timed_out = report.clone();
        timed_out["files"]["/Sources/Example.swift"]["mutants"][0]["status"] = json!("Timeout");
        assert_eq!(
            results(root.path(), &plan, &timed_out, "hash", root.path(), &[])?,
            Counts {
                inconclusive: vec!["one".to_owned()],
                ..Counts::default()
            }
        );
        let mut crashed = report.clone();
        crashed["files"]["/Sources/Example.swift"]["mutants"][0]["killedBy"] = Value::Null;
        crashed["files"]["/Sources/Example.swift"]["mutants"][0]["statusReason"] = json!("crash");
        assert!(results(root.path(), &plan, &crashed, "hash", root.path(), &[]).is_err());
        fs::write(
            &log,
            "mutant:    swift-mutation-testing_0\nstatus:    Crash\n",
        )?;
        assert_eq!(
            results(root.path(), &plan, &crashed, "hash", root.path(), &[])?,
            Counts {
                crashed: 1,
                ..Counts::default()
            }
        );
        crashed["files"]["/Sources/Example.swift"]["mutants"][0]["activated"] = json!(false);
        assert!(results(root.path(), &plan, &crashed, "hash", root.path(), &[]).is_err());
        // A test that stopped at the file size cap proves nothing, even though the tool calls it killed.
        fs::write(
            &log,
            "Caught error: Error Domain=NSPOSIXErrorDomain Code=27 \"File too large\"\n",
        )?;
        assert_eq!(
            results(root.path(), &plan, &report, "hash", root.path(), &[])?,
            Counts {
                resource_stopped: vec!["one".to_owned()],
                ..Counts::default()
            }
        );
        fs::write(
            &log,
            "mutant:    swift-mutation-testing_0\nstatus:    Killed\n",
        )?;
        let mut invalid = report.clone();
        invalid["files"]["/Sources/Example.swift"]["mutants"] = json!([]);
        assert!(results(root.path(), &plan, &invalid, "hash", root.path(), &[]).is_err());
        invalid["files"]["/Sources/Example.swift"]["mutants"] = json!([mutant.clone(), mutant]);
        assert!(results(root.path(), &plan, &invalid, "hash", root.path(), &[]).is_err());
        assert!(results(root.path(), &plan, &report, "wrong", root.path(), &[]).is_err());
        for status in [
            "Survived",
            "NoCoverage",
            "CompileError",
            "Pending",
            "Ignored",
        ] {
            let mut invalid = report.clone();
            invalid["files"]["/Sources/Example.swift"]["mutants"][0]["status"] = json!(status);
            assert!(results(root.path(), &plan, &invalid, "hash", root.path(), &[]).is_err());
        }
        for (field, value) in [
            ("activated", json!(false)),
            ("killedBy", json!([])),
            ("fingerprint", json!("unknown")),
        ] {
            let mut invalid = report.clone();
            invalid["files"]["/Sources/Example.swift"]["mutants"][0][field] = value;
            assert!(results(root.path(), &plan, &invalid, "hash", root.path(), &[]).is_err());
        }
        Ok(())
    }

    #[test]
    fn the_scratch_size_counts_every_nested_file() -> Result<()> {
        let directory = tempfile::tempdir()?;
        fs::create_dir_all(directory.path().join("a/b"))?;
        fs::write(directory.path().join("one"), [0; 10])?;
        fs::write(directory.path().join("a/b/two"), [0; 32])?;
        assert_eq!(tree_bytes(directory.path()), 42);
        assert_eq!(tree_bytes(&directory.path().join("missing")), 0);
        Ok(())
    }

    #[test]
    fn the_hang_guard_scales_the_baseline_above_its_floor() {
        assert_eq!(hang_guard(Duration::ZERO), 20);
        assert_eq!(hang_guard(Duration::from_secs(4)), 20);
        assert_eq!(hang_guard(Duration::from_millis(4_001)), 21);
        assert_eq!(hang_guard(Duration::from_secs(30)), 150);
    }
}
