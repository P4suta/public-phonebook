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
    repo.write("apps/ios/version.txt", "1.0.0\n2.0.0\n")?;
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
fn retired_publication_plans_are_not_cli_operations() -> Result<()> {
    let repo = Repository::new()?;
    for command in [
        "plan",
        "verify",
        "dispatch",
        "status",
        "dataset",
        "controller",
        "gate",
    ] {
        assert!(!invoke(&repo, &[command, "--help"])?.status.success());
    }
    Ok(())
}
