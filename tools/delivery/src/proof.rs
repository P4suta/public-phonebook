use crate::{
    model::Digest,
    repository::completed,
    runtime::{read_json, write_json},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::Path,
    process::{Command, Output},
};

const IMAGE: &str = "public-phonebook-delivery-proof:local";
const KANI: &str = "0.68.0";
const IMAGE_ID_LENGTH: usize = 71;
const VERSION_UNWIND: usize = 19;
const CONTROL: &str = "ready_requires_requested_exact_verified_approved_candidate";
const HARNESSES: [&str; 18] = [
    "explicit_store_build_codes_match_the_platform_range",
    "native_version_selection_preserves_shared_and_unknown_inputs",
    "cached_evidence_requires_current_inputs_commands_environment_and_success",
    "workflow_gate_requires_every_selected_check_to_succeed",
    "signing_requires_an_exact_nonempty_unsigned_archive",
    "store_build_numbers_are_positive_and_bounded",
    "accepted_run_numbers_preserve_order_and_identity",
    "accepted_versions_contain_only_decimal_components",
    "oversized_versions_are_refused_before_parsing",
    CONTROL,
    "accepted_and_unknown_outcomes_never_request_another_write",
    "completed_requires_an_exact_accepted_candidate",
    "unrequested_operations_do_not_write",
    "selection_never_removes_affected_checks",
    "unknown_changes_require_selection_and_full_verification",
    "shared_contract_checks_do_not_force_native_publication",
    "extra_targets_cannot_reduce_verification",
    "combined_impacts_preserve_each_requirement",
];

pub fn validate_results(report: &Value, expected: &[&str], counterexample: bool) -> Result<()> {
    let summary = &report["verification_results"]["summary"];
    ensure!(
        !expected.is_empty()
            && summary["status"] == "completed"
            && summary["executed"].as_u64() == Some(expected.len() as u64),
        "Incomplete proof inventory; no proof receipt can be issued"
    );
    let results = report["verification_results"]["results"]
        .as_array()
        .context("Missing proof results")?;
    let names: BTreeSet<_> = results
        .iter()
        .map(|result| {
            result["harness_id"]
                .as_str()
                .and_then(|name| name.rsplit("::").next())
                .context("Missing harness name")
        })
        .collect::<Result<_>>()?;
    ensure!(
        results.len() == expected.len() && names == expected.iter().copied().collect(),
        "Unexpected, duplicate, or missing proof harness"
    );
    ensure!(
        summary["failed"].as_u64()
            == Some(if counterexample {
                expected.len() as u64
            } else {
                0
            })
            && summary["successful"].as_u64()
                == Some(if counterexample {
                    0
                } else {
                    expected.len() as u64
                }),
        "Proof summary doesn't match the required verdict"
    );
    for result in results {
        let checks = result["checks"]
            .as_array()
            .context("Missing proof properties")?;
        ensure!(!checks.is_empty(), "Empty proof properties");
        if counterexample {
            ensure!(
                result["status"] == "Failure"
                    && checks
                        .iter()
                        .any(|check| check["category"] == "assertion"
                            && check["status"] == "Failure"),
                "The planted defect didn't produce the required assertion counterexample"
            );
            ensure!(
                checks.iter().all(|check| matches!(
                    check["status"].as_str(),
                    Some("Success" | "Failure" | "Unreachable" | "Satisfied" | "Unsatisfiable")
                )),
                "Incomplete counterexample properties"
            );
        } else {
            ensure!(result["status"] == "Success", "Failed or unsupported proof");
            ensure!(
                checks
                    .iter()
                    .any(|check| check["category"] == "assertion" && check["status"] == "Success"),
                "No reachable successful assertion"
            );
            ensure!(
                checks
                    .iter()
                    .filter(|check| check["category"] == "cover" && check["status"] == "Satisfied")
                    .count()
                    >= 2,
                "Missing reachable witnesses"
            );
            ensure!(
                checks.iter().all(|check| if check["category"] == "cover" {
                    check["status"] == "Satisfied"
                } else {
                    matches!(check["status"].as_str(), Some("Success" | "Unreachable"))
                }),
                "Unverified proof property or unwinding assertion"
            );
        }
    }
    Ok(())
}

fn files(root: &Path, relative: &Path, output: &mut BTreeMap<String, Digest>) -> Result<()> {
    for entry in fs::read_dir(root.join(relative))? {
        let entry = entry?;
        let path = relative.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            if entry.file_name() != "target" {
                files(root, &path, output)?;
            }
        } else {
            ensure!(
                entry.file_type()?.is_file(),
                "Proof input must be an ordinary file"
            );
            output.insert(
                path.to_string_lossy().into_owned(),
                Digest::of(&fs::read(entry.path())?),
            );
        }
    }
    Ok(())
}

fn inputs(root: &Path) -> Result<BTreeMap<String, Digest>> {
    let mut result = BTreeMap::new();
    files(root, Path::new("tools/delivery"), &mut result)?;
    files(root, Path::new("verification/delivery"), &mut result)?;
    Ok(result)
}

pub fn require_current(root: &Path) -> Result<()> {
    let receipt: Value = read_json(&root.join("target/delivery/proof/receipt.json"))
        .context("Run delivery-prove for the current candidate before signing")?;
    ensure!(
        receipt["format"] == 1
            && receipt["result"] == "passed"
            && receipt["verifier"] == KANI
            && receipt["harnesses"] == json!(HARNESSES)
            && receipt["negativeControl"] == CONTROL
            && receipt["inputs"] == serde_json::to_value(inputs(root)?)?,
        "Delivery proof evidence is stale or incomplete"
    );
    Ok(())
}

fn container(image: &str, project: &Path, output: &Path) -> Command {
    let mut command = Command::new("docker");
    command
        .args([
            "run",
            "--rm",
            "--init",
            "--platform",
            "linux/amd64",
            "--network",
            "none",
            "--cpus",
            "2",
            "--memory",
            "4g",
            "--memory-swap",
            "4g",
            "--pids-limit",
            "256",
            "--stop-timeout",
            "2",
            "--workdir",
            "/project",
            "--mount",
        ])
        .arg(format!(
            "type=bind,source={},target=/project",
            project.display()
        ))
        .arg("--mount")
        .arg(format!(
            "type=bind,source={},target=/proof",
            output.display()
        ))
        .arg(image)
        .args(["timeout", "900s", "cargo", "kani"]);
    command
}

fn execute(
    image: &str,
    project: &Path,
    output: &Path,
    name: &str,
    harness: Option<&str>,
) -> Result<Output> {
    let report = output.join(format!("{name}.json"));
    if report.exists() {
        fs::remove_file(report)?;
    }
    let mut command = container(image, project, output);
    command
        .args([
            "--output-format",
            "terse",
            "-Z",
            "unstable-options",
            "--jobs",
            "1",
            "--harness-timeout",
            "120s",
            "--export-json",
        ])
        .arg(format!("/proof/{name}.json"));
    if let Some(harness) = harness {
        command.args(["--harness", harness]);
    }
    let result = command
        .output()
        .context("Cannot execute bounded Kani proof")?;
    fs::write(output.join(format!("{name}.stdout.log")), &result.stdout)?;
    fs::write(output.join(format!("{name}.stderr.log")), &result.stderr)?;
    Ok(result)
}

pub fn run(root: &Path) -> Result<()> {
    let output = root.join("target/delivery/proof");
    fs::create_dir_all(&output)?;
    let receipt = output.join("receipt.json");
    let lock = fs::File::create(output.join("run.lock"))?;
    lock.try_lock()
        .context("Another delivery proof owns this checkout")?;
    if receipt.exists() {
        fs::remove_file(&receipt)?;
    }
    let before = inputs(root)?;
    crate::fuzz::run(root)?;
    let image = match env::var("PHONEBOOK_DELIVERY_PROOF_IMAGE") {
        Ok(image) => image,
        Err(env::VarError::NotPresent) => {
            let mut command = Command::new("docker");
            command.current_dir(root).args([
                "build",
                "--platform",
                "linux/amd64",
                "--tag",
                IMAGE,
                "--file",
                "verification/delivery/Dockerfile",
                ".",
            ]);
            completed(command)?;
            IMAGE.to_owned()
        }
        Err(error) => return Err(error.into()),
    };
    let mut inspect = Command::new("docker");
    inspect.args(["image", "inspect", "--format", "{{.Id}}", &image]);
    let identity = String::from_utf8(completed(inspect)?.stdout)?
        .trim()
        .to_owned();
    ensure!(
        identity.starts_with("sha256:") && identity.len() == IMAGE_ID_LENGTH,
        "Invalid proof image identity"
    );
    let mut version = Command::new("docker");
    version.args([
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "--network",
        "none",
        "--cpus",
        "2",
        "--memory",
        "4g",
        "--memory-swap",
        "4g",
        "--pids-limit",
        "256",
        &identity,
        "timeout",
        "60s",
        "cargo",
        "kani",
        "--version",
    ]);
    let version = String::from_utf8(completed(version)?.stdout)?;
    ensure!(
        version.lines().collect::<Vec<_>>()
            == [
                format!("Kani Rust Verifier {KANI} (cargo plugin)"),
                "CBMC 6.11.0".to_owned()
            ],
        "Unexpected Kani or CBMC version"
    );
    let scratch = tempfile::tempdir_in(&output)?;
    let project = scratch.path().join("core");
    fs::create_dir_all(project.join("src"))?;
    fs::copy(
        root.join("tools/delivery/core/Cargo.toml"),
        project.join("Cargo.toml"),
    )?;
    for entry in fs::read_dir(root.join("tools/delivery/core/src"))? {
        let entry = entry?;
        ensure!(entry.file_type()?.is_file(), "Unexpected core input");
        fs::copy(entry.path(), project.join("src").join(entry.file_name()))?;
    }
    let production = execute(&identity, &project, &output, "production", None)?;
    let report: Value = read_json(&output.join("production.json"))
        .context("Kani stopped without a complete report; evidence is inconclusive")?;
    validate_results(&report, &HARNESSES, false)?;
    ensure!(
        production.status.success(),
        "Kani process failed despite its report"
    );
    let core = project.join("apps/web/src/lib.rs");
    let source = fs::read_to_string(&core)?;
    const GUARD: &str = "if !facts.checks_passed {";
    ensure!(
        source.matches(GUARD).count() == 1,
        "The admission counterexample has no unique production guard"
    );
    fs::write(
        &core,
        source.replace(GUARD, "if false && !facts.checks_passed {"),
    )?;
    let rejected = execute(
        &identity,
        &project,
        &output,
        "rejected-evidence",
        Some(CONTROL),
    )?;
    let counterexample: Value = read_json(&output.join("rejected-evidence.json"))
        .context("The rejecting control didn't complete")?;
    validate_results(&counterexample, &[CONTROL], true)?;
    ensure!(
        !rejected.status.success(),
        "The rejecting control unexpectedly succeeded"
    );
    ensure!(
        inputs(root)? == before,
        "Delivery proof inputs changed during verification"
    );
    write_json(
        &receipt,
        &json!({"format":1,"result":"passed","verifier":KANI,"image":identity,"inputs":before,"harnesses":HARNESSES,"negativeControl":CONTROL,"unwind":VERSION_UNWIND,"jobs":1,"semantics":"Kani executable Rust, all admitted bitsets and finite integers; version parser byte slices through 18 bytes; process and provider adapters require separate tests"}),
    )?;
    println!(
        "Delivery proof: {} harnesses and the rejected missing-evidence defect passed",
        HARNESSES.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn report() -> Value {
        json!({"verification_results":{"summary":{"status":"completed","executed":1,"failed":0,"successful":1},"results":[{"harness_id":CONTROL,"status":"Success","checks":[{"category":"assertion","status":"Success"},{"category":"cover","status":"Satisfied"},{"category":"cover","status":"Satisfied"}]}]}})
    }
    #[test]
    fn incomplete_vacuous_skipped_duplicate_and_failed_proofs_never_issue_evidence() -> Result<()> {
        validate_results(&report(), &[CONTROL], false)?;
        for pointer in [
            "/verification_results/summary/status",
            "/verification_results/results/0/status",
            "/verification_results/results/0/checks/0/status",
            "/verification_results/results/0/checks/1/status",
        ] {
            let mut value = report();
            *value
                .pointer_mut(pointer)
                .context("Missing fixture property")? = json!("Unsupported");
            assert!(validate_results(&value, &[CONTROL], false).is_err());
        }
        assert!(validate_results(&report(), &[], false).is_err());
        assert!(validate_results(&report(), &[CONTROL, CONTROL], false).is_err());
        assert!(validate_results(&report(), &[CONTROL], true).is_err());
        let mut failure = report();
        failure["verification_results"]["summary"]["failed"] = json!(1);
        failure["verification_results"]["summary"]["successful"] = json!(0);
        failure["verification_results"]["results"][0]["status"] = json!("Failure");
        failure["verification_results"]["results"][0]["checks"][0]["status"] = json!("Failure");
        validate_results(&failure, &[CONTROL], true)?;
        assert!(validate_results(&failure, &[CONTROL], false).is_err());
        Ok(())
    }
}
