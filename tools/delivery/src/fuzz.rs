use crate::{repository::completed, runtime::write_json};
use anyhow::{Result, ensure};
use serde_json::json;
use std::{fs, path::Path, process::Command};

const IMAGE: &str = "public-phonebook-delivery-fuzz:local";
const BINARY: &str =
    "/work/tools/delivery/fuzz/target/x86_64-unknown-linux-gnu/release/version_identities";
const CORPUS: &str = "tools/delivery/fuzz/corpus/version_identities";
const RUNS: u32 = 10_000;
const SEED: u32 = 13579;
const MAXIMUM_INPUT_BYTES: usize = 4096;
const CONTAINER_CORPUS: &str = "/work/tools/delivery/fuzz/corpus/version_identities";
const SEEDS: [(&str, &[u8]); 10] = [
    ("canonical", b"1.2.3"),
    ("zero", b"0.0.0"),
    ("maximum", b"65535.65535.65535"),
    ("overflow", b"65536.0.0"),
    ("leading-zero", b"01.0.0"),
    ("missing", b"1.0"),
    ("suffix", b"1.0.0-rc1"),
    ("line-ending", b"1.0.0\n"),
    ("non-utf8", b"\xff\0.0.0"),
    ("empty", b""),
];

pub fn write_corpus(root: &Path) -> Result<()> {
    let directory = root.join(CORPUS);
    fs::create_dir_all(&directory)?;
    for (name, bytes) in SEEDS {
        fs::write(directory.join(name), bytes)?;
    }
    Ok(())
}

pub fn run(root: &Path) -> Result<()> {
    let mut corpus = Vec::new();
    for entry in fs::read_dir(root.join(CORPUS))? {
        let entry = entry?;
        ensure!(
            entry.file_type()?.is_file(),
            "Corpus inputs must be ordinary files"
        );
        corpus.push(
            entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("Non-UTF-8 corpus name"))?,
        );
    }
    corpus.sort();
    ensure!(
        corpus.len() >= SEEDS.len(),
        "The version corpus is incomplete"
    );
    let output = root.join("target/delivery/fuzz");
    fs::create_dir_all(&output)?;
    let mut build = Command::new("docker");
    build.current_dir(root).args([
        "build",
        "--platform",
        "linux/amd64",
        "--tag",
        IMAGE,
        "--file",
        "verification/delivery/fuzz.Dockerfile",
        ".",
    ]);
    completed(build)?;
    let execute = |name: &str, arguments: &[String]| -> Result<String> {
        let mut command = Command::new("docker");
        command.args([
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
            "128",
            IMAGE,
            "timeout",
            "180s",
            BINARY,
        ]);
        command.args(arguments);
        let result = command.output()?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        fs::write(output.join(format!("{name}.log")), &text)?;
        ensure!(
            result.status.success(),
            "Version fuzz {name} failed or stopped inconclusively; inspect target/delivery/fuzz/{name}.log"
        );
        Ok(text)
    };
    let arguments: Vec<_> = corpus
        .iter()
        .map(|name| format!("{CONTAINER_CORPUS}/{name}"))
        .collect();
    let replay = execute("replay", &arguments)?;
    ensure!(
        corpus
            .iter()
            .all(|name| replay.contains(&format!("Running: {CONTAINER_CORPUS}/{name}"))),
        "The fuzzer didn't replay every committed input"
    );
    let campaign = execute(
        "campaign",
        &[
            CONTAINER_CORPUS.to_owned(),
            format!("-runs={RUNS}"),
            format!("-seed={SEED}"),
            format!("-max_len={MAXIMUM_INPUT_BYTES}"),
        ],
    )?;
    ensure!(
        campaign.contains(&format!("#{RUNS}\tDONE")) && campaign.contains(&format!("Seed: {SEED}")),
        "The fixed fuzz campaign didn't complete its declared work"
    );
    write_json(
        &output.join("receipt.json"),
        &json!({"result":"passed","cargoFuzz":"0.13.2","libfuzzerSys":"0.4.13","nightly":"2026-08-21","replayed":corpus,"runs":RUNS,"seed":SEED,"maximumInputBytes":MAXIMUM_INPUT_BYTES}),
    )?;
    println!(
        "Version fuzz: {} corpus inputs replayed and {RUNS} fixed-seed runs passed",
        corpus.len()
    );
    Ok(())
}
