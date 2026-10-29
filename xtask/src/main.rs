use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

const ADVISORIES: &str = "40f5be6fb12ed93fc591bf4ab23b7d793b3f2239";
const ADVISORY_REPOSITORY: &str = "https://github.com/RustSec/advisory-db.git";
const IMAGE_ID_LENGTH: usize = "sha256:".len() + 64;
const FUZZ_CORPUS: &str = "fuzz/corpus/core_contracts";
const FUZZ_CONTAINER_CORPUS: &str = "/workspace/fuzz/corpus/core_contracts";
const FUZZ_BINARY_DIRECTORY: &str = "/usr/local/bin";
const FUZZ_INPUT_LIMIT: usize = 256;
const FUZZ_ERROR_EXIT: i32 = 77;
const FUZZ_NEGATIVE_MARKER: &str = "negative control: nonempty corpus input reached";
const FUZZ_NEGATIVE_PASSED: &str =
    "PASS: false round-trip claim rejected at its assertion with exit 77";
const FUZZ_ARGUMENTS: [&str; 6] = [
    FUZZ_CONTAINER_CORPUS,
    "-runs=0",
    "-seed=1",
    "-max_len=256",
    "-error_exitcode=77",
    "-artifact_prefix=/workspace/fuzz/artifacts/",
];
const HARNESSES: [&str; 13] = [
    "canonical_numbers_are_bounded_and_reparse",
    "special_bytes_cannot_add_properties",
    "municipality_codes_preserve_validated_digits",
    "phone_characters_preserve_the_declared_alphabet",
    "table_spans_refuse_overflow_and_preserve_bounds",
    "childcare_admission_excludes_inactive_and_individual_care",
    "page_windows_cover_results_without_arithmetic_overflow",
    "streaming_chunk_plans_preserve_capacity_and_progress",
    "prefecture_codes_admit_exactly_the_47_ascii_codes",
    "export_formats_reject_unknown_names_and_preserve_the_selected_mime",
    "csv_text_prefixes_preserve_text_boundaries_for_every_unicode_scalar",
    "snapshot_identities_admit_exactly_lowercase_sha256_bytes",
    "api_problems_preserve_status_codes_and_retry_semantics",
];

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Task,
}
#[derive(Subcommand)]
enum Task {
    FuzzReplay,
    #[command(hide = true)]
    FuzzNegativeControl,
    Prove {
        #[arg(long)]
        harness: Option<String>,
    },
    CheckWeb,
    Audit,
    Check {
        #[arg(long)]
        data: bool,
        #[arg(long)]
        proofs: bool,
        #[arg(long)]
        fuzz: bool,
        #[arg(long)]
        browsers: bool,
        #[arg(long)]
        cloudflare: bool,
        #[arg(long, requires = "data")]
        baseline: Option<PathBuf>,
    },
}

fn checked(command: &mut Command) -> Result<Output> {
    let result = command.output().context("Start verification command")?;
    ensure!(
        result.status.success(),
        "Verification command failed: {}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(result)
}

fn proof_passed(output: &str) -> bool {
    HARNESSES.iter().all(|h| output.contains(h))
        && output.contains(&format!(
            "{} successfully verified harnesses, 0 failures",
            HARNESSES.len()
        ))
}

fn bounded_command(root: &Path, image: &str) -> Command {
    let managed = Command::new("dotfiles")
        .args(["bounded", "run", "--help"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if managed {
        let mut c = Command::new("dotfiles");
        c.args(["bounded", "run", "--image", image, "--project"])
            .arg(root)
            .arg("--");
        c
    } else {
        let mut c = Command::new("docker");
        c.args([
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
        c
    }
}

fn run_proof(root: &Path, image: &str, negative: bool, harness: Option<&str>) -> Result<Output> {
    let mut command = bounded_command(root, image);
    command.args([
        "cargo",
        "kani",
        "-p",
        "phonebook-core",
        "--output-format",
        "terse",
    ]);
    if negative {
        command.args([
            "--features",
            "proof-negative-control",
            "--harness",
            "reject_a_false_escape_claim",
        ]);
    } else if let Some(harness) = harness {
        command.args(["--harness", harness]);
    }
    Ok(command.output()?)
}

fn prove(root: &Path, harness: Option<&str>) -> Result<()> {
    ensure!(
        harness.is_none_or(|name| HARNESSES.contains(&name)),
        "Unknown production harness"
    );
    fs::create_dir_all(root.join("target"))?;
    println!("Preparing pinned Kani 0.68.0 container");
    let image_file = root.join("target/proof-image.id");
    checked(
        Command::new("docker")
            .current_dir(root)
            .args([
                "build",
                "--quiet",
                "--platform",
                "linux/amd64",
                "--file",
                "verification/Dockerfile",
                "--iidfile",
            ])
            .arg(&image_file)
            .arg("."),
    )?;
    let image = fs::read_to_string(image_file)?.trim().to_owned();
    ensure!(
        image.starts_with("sha256:") && image.len() == IMAGE_ID_LENGTH,
        "Invalid immutable image ID"
    );
    let snapshot = tempfile::tempdir_in(root.join("target"))?;
    let core = snapshot.path().join("crates/phonebook-core");
    fs::create_dir_all(core.join("src"))?;
    let paths = [
        "Cargo.toml",
        "crates/phonebook-core/Cargo.toml",
        "crates/phonebook-core/src/lib.rs",
        "verification/Dockerfile",
        "xtask/src/main.rs",
        "Cargo.lock",
    ];
    let mut hashes = serde_json::Map::new();
    for path in paths {
        let bytes = fs::read(root.join(path))?;
        hashes.insert(path.into(), format!("{:x}", Sha256::digest(&bytes)).into());
        if path.starts_with("crates/") {
            fs::write(snapshot.path().join(path), bytes)?;
        }
    }
    let mut manifest = fs::read_to_string(root.join("Cargo.toml"))?;
    let start = manifest
        .find("members = ")
        .context("Workspace members missing")?;
    let end = start
        + manifest[start..]
            .find('\n')
            .context("Workspace members line missing")?;
    manifest.replace_range(start..end, "members = [\"crates/phonebook-core\"]");
    fs::write(snapshot.path().join("Cargo.toml"), manifest)?;
    println!("Checking production harnesses under fixed bounds");
    let result = run_proof(snapshot.path(), &image, false, harness)?;
    let log = format!(
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let log_path = harness.map_or_else(
        || "target/proof.log".to_owned(),
        |name| format!("target/proof-{name}.log"),
    );
    fs::write(root.join(log_path), &log)?;
    if let Some(harness) = harness {
        ensure!(
            result.status.success()
                && log.contains(harness)
                && log.contains("1 successfully verified harnesses, 0 failures"),
            "Selected proof incomplete; inspect its target/proof-*.log"
        );
        println!(
            "PASS: selected production harness {harness}; full receipt requires all harnesses"
        );
        return Ok(());
    }
    ensure!(
        result.status.success() && proof_passed(&log),
        "Proof incomplete; see target/proof.log"
    );
    println!("Checking that the gate rejects a false escape claim");
    let negative = run_proof(snapshot.path(), &image, true, None)?;
    let negative_log = format!(
        "{}\n{}",
        String::from_utf8_lossy(&negative.stdout),
        String::from_utf8_lossy(&negative.stderr)
    );
    fs::write(root.join("target/proof-negative.log"), &negative_log)?;
    ensure!(
        !negative.status.success()
            && negative_log.contains("negative control: raw newline retained")
            && negative_log.contains("1 failures"),
        "Negative control did not fail as expected; see target/proof-negative.log"
    );
    for (path, expected) in &hashes {
        ensure!(
            format!("{:x}", Sha256::digest(fs::read(root.join(path))?))
                == expected.as_str().unwrap_or_default(),
            "Source changed during proof run"
        );
    }
    fs::write(
        root.join("target/proof-receipt.json"),
        serde_json::to_vec_pretty(
            &serde_json::json!({"image": image, "kani": "0.68.0", "harnesses": HARNESSES, "sources": hashes, "negative_control": "expected assertion failure"}),
        )?,
    )?;
    println!(
        "PASS: {} production harnesses; false claim rejected; source-bound receipt in target/proof-receipt.json",
        HARNESSES.len()
    );
    Ok(())
}

fn fuzz_replay(root: &Path) -> Result<()> {
    fs::create_dir_all(root.join("target"))?;
    fs::create_dir_all(root.join("fuzz/artifacts"))?;
    let mut sources = std::collections::BTreeMap::new();
    for path in [
        "Cargo.toml",
        "Cargo.lock",
        "crates/phonebook-core/Cargo.toml",
        "crates/phonebook-core/src/lib.rs",
        "fuzz/Cargo.toml",
        "fuzz/Cargo.lock",
        "fuzz/fuzz_targets/core_contracts.rs",
        "fuzz/fuzz_targets/reject_false_roundtrip.rs",
        "verification/fuzz.Dockerfile",
        "xtask/src/main.rs",
    ] {
        sources.insert(
            path.to_owned(),
            format!("{:x}", Sha256::digest(fs::read(root.join(path))?)),
        );
    }
    let mut corpus_count = 0;
    for entry in fs::read_dir(root.join(FUZZ_CORPUS))? {
        let entry = entry?;
        ensure!(
            entry.file_type()?.is_file(),
            "Corpus entries must be regular files"
        );
        let path = entry.path();
        let bytes = fs::read(&path)?;
        ensure!(
            !bytes.is_empty() && bytes.len() <= FUZZ_INPUT_LIMIT,
            "Invalid corpus input size"
        );
        let relative = path
            .strip_prefix(root)?
            .to_str()
            .context("Corpus path must be UTF-8")?
            .to_owned();
        sources.insert(relative, format!("{:x}", Sha256::digest(bytes)));
        corpus_count += 1;
    }
    ensure!(corpus_count > 0, "Fuzz corpus is empty");
    let image_file = root.join("target/fuzz-image.id");
    checked(
        Command::new("docker")
            .current_dir(root)
            .args([
                "build",
                "--quiet",
                "--platform",
                "linux/amd64",
                "--file",
                "verification/fuzz.Dockerfile",
                "--iidfile",
            ])
            .arg(&image_file)
            .arg("."),
    )?;
    let image = fs::read_to_string(image_file)?.trim().to_owned();
    ensure!(
        image.starts_with("sha256:") && image.len() == IMAGE_ID_LENGTH,
        "Invalid immutable fuzz image ID"
    );
    let run = |binary: &str| -> Result<Output> {
        Ok(bounded_command(root, &image)
            .arg(Path::new(FUZZ_BINARY_DIRECTORY).join(binary))
            .args(FUZZ_ARGUMENTS)
            .output()?)
    };
    let positive = run("phonebook-fuzz")?;
    let positive_log = format!(
        "{}\n{}",
        String::from_utf8_lossy(&positive.stdout),
        String::from_utf8_lossy(&positive.stderr)
    );
    fs::write(root.join("target/fuzz-replay.log"), &positive_log)?;
    ensure!(
        positive.status.success(),
        "Corpus replay failed; inspect target/fuzz-replay.log"
    );
    let negative = bounded_command(root, &image)
        .arg(Path::new(FUZZ_BINARY_DIRECTORY).join("phonebook-verification"))
        .arg("fuzz-negative-control")
        .output()?;
    let negative_log = format!(
        "{}\n{}",
        String::from_utf8_lossy(&negative.stdout),
        String::from_utf8_lossy(&negative.stderr)
    );
    fs::write(root.join("target/fuzz-negative.log"), &negative_log)?;
    ensure!(
        negative.status.success() && negative_log.contains(FUZZ_NEGATIVE_PASSED),
        "Fuzz negative control did not fail at the expected assertion"
    );
    for (path, expected) in &sources {
        ensure!(
            format!("{:x}", Sha256::digest(fs::read(root.join(path))?)) == *expected,
            "Source or corpus changed during replay"
        );
    }
    fs::write(
        root.join("target/fuzz-receipt.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "image":image, "cargo_fuzz":"0.13.2", "nightly":"nightly-2026-10-22",
            "mode":"corpus-replay", "target":"core_contracts", "corpus_inputs":corpus_count,
            "negative_control":"expected assertion and exit 77", "sources":sources,
        }))?,
    )?;
    println!(
        "PASS: {corpus_count} fuzz corpus inputs; false round-trip claim rejected; source-bound receipt in target/fuzz-receipt.json"
    );
    Ok(())
}

fn fuzz_negative_control() -> Result<()> {
    let result = Command::new(Path::new(FUZZ_BINARY_DIRECTORY).join("phonebook-fuzz-negative"))
        .args(FUZZ_ARGUMENTS)
        .output()?;
    let log = format!(
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    print!("{log}");
    ensure!(
        result.status.code() == Some(FUZZ_ERROR_EXIT) && log.contains(FUZZ_NEGATIVE_MARKER),
        "Fuzz target did not fail at the expected assertion and exit"
    );
    println!("{FUZZ_NEGATIVE_PASSED}");
    Ok(())
}

fn audit(root: &Path) -> Result<()> {
    let database = root.join("target/advisory-db");
    if !database.join(".git").is_dir() {
        fs::create_dir_all(&database)?;
        checked(Command::new("git").arg("init").arg(&database))?;
    }
    checked(Command::new("git").arg("-C").arg(&database).args([
        "fetch",
        "--depth",
        "1",
        ADVISORY_REPOSITORY,
        ADVISORIES,
    ]))?;
    checked(
        Command::new("git")
            .arg("-C")
            .arg(&database)
            .args(["checkout", "--detach", ADVISORIES]),
    )?;
    for lockfile in ["Cargo.lock", "fuzz/Cargo.lock"] {
        let result = checked(
            Command::new("cargo")
                .current_dir(root)
                .args(["audit", "--no-fetch", "--db"])
                .arg(&database)
                .args(["--file", lockfile]),
        )?;
        print!(
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
    println!("Advisory snapshot: {ADVISORIES}");
    Ok(())
}

fn check_web(root: &Path) -> Result<()> {
    let generated = tempfile::tempdir()?;
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    checked(
        Command::new(npm)
            .current_dir(root)
            .args([
                "exec",
                "--no",
                "--",
                "tsc",
                "-p",
                "web/tsconfig.json",
                "--outDir",
            ])
            .arg(generated.path()),
    )?;
    for name in ["app.js", "api.js"] {
        let actual = fs::read(generated.path().join(name))?;
        ensure!(
            !actual.is_empty() && actual == fs::read(root.join("static").join(name))?,
            "Frontend output is stale; run npm run build:web"
        );
    }
    println!("PASS: embedded frontend matches the checked TypeScript source");
    Ok(())
}

fn main() -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .context("Workspace root missing")?;
    match Cli::parse().command {
        Task::FuzzReplay => fuzz_replay(root),
        Task::FuzzNegativeControl => fuzz_negative_control(),
        Task::Prove { harness } => prove(root, harness.as_deref()),
        Task::CheckWeb => check_web(root),
        Task::Audit => audit(root),
        Task::Check {
            data,
            proofs,
            fuzz,
            browsers,
            cloudflare,
            baseline,
        } => {
            if data {
                let mut command = Command::new("cargo");
                command.current_dir(root).args([
                    "run",
                    "--locked",
                    "-p",
                    "public-phonebook",
                    "--",
                    "verify-data",
                ]);
                if let Some(baseline) = baseline {
                    command.arg("--baseline").arg(baseline);
                }
                let result = checked(&mut command)?;
                print!("{}", String::from_utf8_lossy(&result.stdout));
            }
            if proofs {
                prove(root, None)?;
            }
            if fuzz {
                fuzz_replay(root)?;
            }
            if browsers {
                let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
                for script in if data {
                    vec!["e2e", "e2e:national"]
                } else {
                    vec!["e2e"]
                } {
                    println!("Running browser suite: {script}");
                    let result =
                        checked(Command::new(npm).current_dir(root).args(["run", script]))?;
                    print!("{}", String::from_utf8_lossy(&result.stdout));
                }
            }
            if cloudflare {
                let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
                for script in ["build:cloudflare", "e2e:cloudflare"] {
                    println!("Running Cloudflare check: {script}");
                    let result =
                        checked(Command::new(npm).current_dir(root).args(["run", script]))?;
                    print!("{}", String::from_utf8_lossy(&result.stdout));
                }
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_skipped_failed_or_tool_error_is_not_a_proof() {
        let success = format!(
            "{} {} successfully verified harnesses, 0 failures",
            HARNESSES.join(" "),
            HARNESSES.len()
        );
        assert!(proof_passed(&success));
        for bad in [
            "",
            "tool error",
            "0 successfully verified harnesses, 0 failures",
            "2 successfully verified harnesses, 1 failures",
            "3 successfully verified harnesses, 1 failures",
            "4 successfully verified harnesses, 1 failures",
        ] {
            assert!(!proof_passed(bad));
        }
        assert!(!proof_passed(
            &success.replace(HARNESSES[0], "unrelated_harness")
        ));
    }
}
