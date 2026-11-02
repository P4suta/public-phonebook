use super::{logged, require_current_sources, source_hashes, source_records};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    process::Command,
};

const VERSION: &str = "1.6.4";
const OPERATORS: [&str; 7] = [
    "RelationalOperatorReplacement",
    "BooleanLiteralReplacement",
    "LogicalOperatorReplacement",
    "ArithmeticOperatorReplacement",
    "NegateConditional",
    "SwapTernary",
    "RemoveSideEffects",
];

#[derive(Debug, Default, PartialEq)]
struct Counts {
    killed: usize,
    compiler_rejected: usize,
}

fn declaration_rejection(root: &Path, mutant: &Value, log: &str) -> bool {
    if mutant["file"] != "Sources/PhonebookCore/Contracts.swift"
        || mutant["operator"] != "RelationalOperatorReplacement"
        || mutant["replacementKind"] != "binaryOperator"
        || mutant["original"] != "<"
        || !matches!(mutant["replacement"].as_str(), Some("<=" | ">"))
        || mutant["schematizable"] != false
        || !log.contains("type 'PrefectureCode' does not conform to protocol 'Comparable'")
        || !log.contains("protocol requires function '<'")
    {
        return false;
    }
    let Ok(source) = fs::read_to_string(root.join("ios/Sources/PhonebookCore/Contracts.swift"))
    else {
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
            match mutant["status"].as_str() {
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
                    let id = mutant["id"]
                        .as_str()
                        .context("Missing compiler-rejected mutant identity")?;
                    ensure!(
                        id.strip_prefix("swift-mutation-testing_")
                            .is_some_and(|suffix| !suffix.is_empty()
                                && suffix.bytes().all(|byte| byte.is_ascii_digit())),
                        "Invalid mutation log name"
                    );
                    let log = fs::read_to_string(logs.join(format!("{id}.log")))?;
                    ensure!(
                        declaration_rejection(root, planned, &log),
                        "An unexplained mutation build failure supplies no test evidence"
                    );
                    counts.compiler_rejected += 1;
                }
                status => anyhow::bail!(
                    "Mutation {fingerprint} is {status:?}; a survivor, timeout, or uncovered mutant cannot pass"
                ),
            }
        }
    }
    ensure!(
        observed.len() == expected.len() && counts.killed > 0,
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
        logged(
            root,
            &format!("mutation-{name}"),
            Command::new("swift-mutation-testing")
                .current_dir(root.join("ios"))
                .args(["run", ".", "--plan"])
                .arg(&plan_path)
                .args([
                    "--concurrency",
                    "1",
                    "--timeout",
                    "20",
                    "--build-timeout",
                    "120",
                    "--no-cache",
                    "--min-score",
                    "100",
                    "--max-integrity-warnings",
                    "0",
                    "--output",
                ])
                .arg(&report_path)
                .arg("--keep-logs")
                .arg(&logs),
        )?;
        let hash = crate::sha256_hex(plan_bytes);
        let counts = results(
            root,
            &plan,
            &serde_json::from_slice(&fs::read(&report_path)?)?,
            &hash,
            &logs,
        )?;
        profiles.push(json!({"scope":source,"target":target,"plan":plan_path,"report":report_path,"plan_sha256":hash,"killed":counts.killed,"compiler_rejected_declaration_renames":counts.compiler_rejected,"survived":0,"timeouts":0,"uncovered":0}));
    }
    require_current_sources(root, &sources)?;
    fs::write(
        receipt,
        serde_json::to_vec_pretty(
            &json!({"result":"passed","tool":"swift-mutation-testing","version":VERSION,"workers":1,"operators":OPERATORS,"profiles":profiles,"source_sha256":source_records(&sources),"scope_limit":"pure core and extension notification policy; not every application or framework path","compiler_rejection":"Only source-checked renames of the required Comparable operator with the matching compiler diagnostic; never counted as killed"}),
        )?,
    )?;
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
        Ok(())
    }

    #[test]
    fn mutation_receipts_reject_missing_duplicate_unactivated_and_non_killed_cases() -> Result<()> {
        let root = tempfile::tempdir()?;
        let planned = json!({"fingerprint":"one","file":"Sources/Example.swift","operator":"NegateConditional","original":"ready","replacement":"!ready","line":1,"column":1});
        let plan = json!({"formatVersion":1,"toolVersion":VERSION,"scope":{"operators":OPERATORS,"excludePatterns":[]},"mutants":[planned]});
        let mutant = json!({"fingerprint":"one","id":"swift-mutation-testing_0","mutatorName":"NegateConditional","originalText":"ready","replacement":"!ready","location":{"start":{"line":1,"column":1}},"status":"Killed","activated":true,"killedBy":["contract()"]});
        let report = json!({"config":{"toolVersion":VERSION,"planSha256":"hash"},"files":{"/Sources/Example.swift":{"mutants":[mutant.clone()]}}});
        assert_eq!(
            results(root.path(), &plan, &report, "hash", root.path())?,
            Counts {
                killed: 1,
                compiler_rejected: 0
            }
        );
        let mut invalid = report.clone();
        invalid["files"]["/Sources/Example.swift"]["mutants"] = json!([]);
        assert!(results(root.path(), &plan, &invalid, "hash", root.path()).is_err());
        invalid["files"]["/Sources/Example.swift"]["mutants"] = json!([mutant.clone(), mutant]);
        assert!(results(root.path(), &plan, &invalid, "hash", root.path()).is_err());
        assert!(results(root.path(), &plan, &report, "wrong", root.path()).is_err());
        for status in [
            "Survived",
            "Timeout",
            "NoCoverage",
            "CompileError",
            "Pending",
            "Ignored",
        ] {
            let mut invalid = report.clone();
            invalid["files"]["/Sources/Example.swift"]["mutants"][0]["status"] = json!(status);
            assert!(results(root.path(), &plan, &invalid, "hash", root.path()).is_err());
        }
        for (field, value) in [
            ("activated", json!(false)),
            ("killedBy", json!([])),
            ("fingerprint", json!("unknown")),
        ] {
            let mut invalid = report.clone();
            invalid["files"]["/Sources/Example.swift"]["mutants"][0][field] = value;
            assert!(results(root.path(), &plan, &invalid, "hash", root.path()).is_err());
        }
        Ok(())
    }
}
