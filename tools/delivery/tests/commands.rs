mod support;
use anyhow::Result;
use std::process::{Command, Output};
use support::Repository;

fn invoke(repo: &Repository, arguments: &[&str]) -> Result<Output> {
    Ok(Command::new(env!("CARGO_BIN_EXE_delivery"))
        .arg("--root")
        .arg(&repo.root)
        .args(arguments)
        .output()?)
}

#[test]
fn actual_commands_refuse_invalid_store_numbers_and_source_versions() -> Result<()> {
    let repo = Repository::new()?;
    for (arguments, expected) in [
        (vec!["version", "ios"], "1.0.0\n"),
        (vec!["version", "android"], "1.0.0\n"),
        (vec!["build-number", "42"], "4201\n"),
        (vec!["store-build-number", "2100000000"], "2100000000\n"),
    ] {
        let output = invoke(&repo, &arguments)?;
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout)?, expected);
    }
    for arguments in [
        ["build-number", "0"],
        ["build-number", "4294967295"],
        ["store-build-number", "0"],
        ["store-build-number", "2100000001"],
    ] {
        assert!(!invoke(&repo, &arguments)?.status.success());
    }
    repo.write("ios/version.txt", "1.0.0\n2.0.0\n")?;
    assert!(!invoke(&repo, &["version", "ios"])?.status.success());
    assert!(
        !invoke(&repo, &["admit", &"a".repeat(64), &"b".repeat(64)])?
            .status
            .success()
    );
    assert!(
        invoke(&repo, &["admit", &"a".repeat(64), &"a".repeat(64)])?
            .status
            .success()
    );
    Ok(())
}

#[test]
fn actual_workflow_gate_rejects_failure_cancellation_and_unexpected_skips() -> Result<()> {
    let repo = Repository::new()?;
    let arguments = [
        "gate",
        "--operation",
        "monitors-apply",
        "--plan",
        "success",
        "--fast",
        "success",
        "--proofs",
        "success",
        "--worker",
        "success",
        "--ios",
        "success",
        "--android",
        "success",
        "--worker-required",
        "true",
        "--ios-required",
        "true",
        "--android-required",
        "true",
    ];
    assert!(invoke(&repo, &arguments)?.status.success());
    for index in [4, 6, 8, 10, 12, 14] {
        for result in ["failure", "cancelled", "skipped"] {
            let mut changed = arguments;
            changed[index] = result;
            assert!(!invoke(&repo, &changed)?.status.success());
        }
    }
    let version = [
        "gate",
        "--operation",
        "version-ios",
        "--plan",
        "success",
        "--fast",
        "success",
        "--proofs",
        "skipped",
        "--worker",
        "skipped",
        "--ios",
        "skipped",
        "--android",
        "skipped",
        "--worker-required",
        "true",
        "--ios-required",
        "true",
        "--android-required",
        "true",
    ];
    assert!(invoke(&repo, &version)?.status.success());
    let mut unexpected = version;
    unexpected[8] = "success";
    assert!(!invoke(&repo, &unexpected)?.status.success());
    Ok(())
}
