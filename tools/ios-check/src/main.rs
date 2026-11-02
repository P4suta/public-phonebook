use anyhow::{Context, Result, ensure};
use clap::Parser;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    process::{Command, Output, Stdio},
};

mod icons;
mod ios;
mod locations;

const ADVISORIES: &str = "2295466c4e9df26647fd67d8fa1c705ac2fc7f81";

/// Formats the SHA-256 of `bytes` as lowercase hexadecimal, which `sha2` 0.11 digests no longer print directly.
fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn audit(root: &Path) -> Result<()> {
    let database = root.join("target/advisory-db");
    if !database.join(".git").is_dir() {
        std::fs::create_dir_all(&database)?;
        checked(Command::new("git").arg("init").arg(&database))?;
    }
    checked(Command::new("git").arg("-C").arg(&database).args([
        "fetch",
        "--depth",
        "1",
        locations::ADVISORY_DATABASE,
        ADVISORIES,
    ]))?;
    checked(
        Command::new("git")
            .arg("-C")
            .arg(&database)
            .args(["checkout", "--detach", ADVISORIES]),
    )?;
    let status = checked(
        Command::new("git")
            .arg("-C")
            .arg(&database)
            .args(["status", "--porcelain"]),
    )?;
    ensure!(
        status.stdout.is_empty(),
        "The advisory snapshot was modified"
    );
    let result = checked(
        Command::new("cargo")
            .current_dir(root)
            .args(["audit", "--no-fetch", "--stale", "--no-yanked", "--db"])
            .arg(&database)
            .args(["--file", "tools/ios-check/Cargo.lock"]),
    )?;
    print!(
        "{}{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    println!(
        "Advisory snapshot: {ADVISORIES}; registry yank status and newer advisories are outside this pinned check"
    );
    Ok(())
}

#[derive(Parser)]
struct Arguments {
    #[command(subcommand)]
    action: ios::Action,
}

fn checked(command: &mut Command) -> Result<Output> {
    let output = command.output().context("Start verification command")?;
    ensure!(
        output.status.success(),
        "Verification command failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(output)
}

fn bounded_command(root: &Path, image: &str) -> Command {
    let managed = Command::new("dotfiles")
        .args(["bounded", "run", "--help"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if managed {
        let mut command = Command::new("dotfiles");
        command
            .args(["bounded", "run", "--image", image, "--project"])
            .arg(root)
            .arg("--");
        command
    } else {
        let mut command = Command::new("docker");
        command
            .args([
                "run",
                "--rm",
                "--platform",
                "linux/amd64",
                "--network",
                "none",
                "--memory",
                "2g",
                "--memory-swap",
                "2g",
                "--cpus",
                "2",
                "--pids-limit",
                "256",
                "--mount",
            ])
            .arg(format!(
                "type=bind,source={},target=/workspace",
                root.display()
            ))
            .args(["--workdir", "/workspace", image, "timeout", "900s"]);
        command
    }
}

fn main() -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    ios::run(&root, Arguments::parse().action)
}
