use super::{device, logged, require_current_sources, source_hashes, source_records};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const TARGET: &str = "arm64-apple-ios18.0-simulator";
const NATIONAL_CONTACTS: u64 = 667_696;
const FIXTURE_QUERIES: u64 = 2200;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Latency {
    p50: f64,
    p95: f64,
    p99: f64,
    maximum: f64,
}

impl Latency {
    fn valid(&self) -> bool {
        [self.p50, self.p95, self.p99, self.maximum]
            .iter()
            .all(|value| value.is_finite() && *value >= 0.0)
            && self.p50 <= self.p95
            && self.p95 <= self.p99
            && self.p99 <= self.maximum
    }
}

fn sources(root: &Path, module: &str) -> Result<Vec<PathBuf>> {
    let mut paths = fs::read_dir(root.join("ios/Sources").join(module))?
        .map(|entry| entry.map(|value| value.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    paths.retain(|path| {
        path.extension()
            .is_some_and(|extension| extension == "swift")
    });
    paths.sort();
    ensure!(
        !paths.is_empty(),
        "The measurement compiled no {module} sources"
    );
    Ok(paths)
}

fn compiler(root: &Path, directory: &Path, sdk: &str) -> Command {
    let mut command = Command::new("xcrun");
    command
        .current_dir(root)
        .args([
            "swiftc",
            "-O",
            "-g",
            "-swift-version",
            "6",
            "-warnings-as-errors",
            "-target",
            TARGET,
            "-sdk",
            sdk,
            "-module-cache-path",
        ])
        .arg(directory.join("module-cache"))
        .arg("-I")
        .arg(directory)
        .arg("-L")
        .arg(directory)
        .arg("-I")
        .arg(root.join("ios/Sources/CSQLite"));
    command
}

pub(super) fn run(root: &Path) -> Result<()> {
    let source = source_hashes(root)?;
    let directory = root.join("target/ios/search-measurements");
    fs::create_dir_all(&directory)?;
    let sdk = logged(
        root,
        "search-sdk",
        Command::new("xcrun").args(["--sdk", "iphonesimulator", "--show-sdk-path"]),
    )?;
    let sdk = String::from_utf8(sdk.stdout)?.trim().to_owned();
    let compiler_version = logged(
        root,
        "search-swift-version",
        Command::new("xcrun").args(["swiftc", "--version"]),
    )?;
    for module in ["PhonebookCore", "PhonebookKit"] {
        let library = format!("lib{module}.dylib");
        let mut command = compiler(root, &directory, &sdk);
        command
            .args([
                "-parse-as-library",
                "-emit-library",
                "-emit-module",
                "-module-name",
                module,
                "-emit-module-path",
            ])
            .arg(directory.join(format!("{module}.swiftmodule")))
            .args([
                "-Xlinker",
                "-install_name",
                "-Xlinker",
                &format!("@rpath/{library}"),
                "-o",
            ])
            .arg(directory.join(&library))
            .args(sources(root, module)?);
        if module == "PhonebookKit" {
            command.args(["-lPhonebookCore", "-lsqlite3"]);
        }
        logged(root, &format!("search-compile-{module}"), &mut command)?;
    }
    let binary = directory.join("search-measurements");
    logged(
        root,
        "search-compile-measurement",
        compiler(root, &directory, &sdk)
            .args([
                "-lPhonebookCore",
                "-lPhonebookKit",
                "-lsqlite3",
                "-Xlinker",
                "-rpath",
                "-Xlinker",
                "@executable_path",
                "-o",
            ])
            .arg(&binary)
            .arg(root.join("ios/SearchMeasurements/main.swift")),
    )?;
    let simulator = device(root)?;
    let mut records = Vec::new();
    for mode in ["core", "import"] {
        let output = directory.join(format!("{mode}.json"));
        if output.exists() {
            fs::remove_file(&output)?;
        }
        logged(
            root,
            &format!("search-measure-{mode}"),
            Command::new("xcrun")
                .args(["simctl", "spawn", simulator.id()])
                .arg(&binary)
                .arg(mode)
                .arg(root.join("target/ios/bundled-dataset/national"))
                .arg(root.join("tests/fixtures/search-ranking.json"))
                .arg(&output),
        )?;
        let record: serde_json::Value = serde_json::from_slice(&fs::read(output)?)?;
        ensure!(
            record["mode"] == mode && record["contacts"] == NATIONAL_CONTACTS,
            "Search measurement changed its population"
        );
        ensure!(
            record["startupMilliseconds"]
                .as_f64()
                .is_some_and(|value| value.is_finite() && value > 0.0),
            "Search startup wasn't measured"
        );
        if mode == "core" {
            ensure!(
                record["comparedQueries"] == FIXTURE_QUERIES,
                "Search measurement omitted rankings"
            );
            let latency: Latency = serde_json::from_value(record["latencyMilliseconds"].clone())?;
            ensure!(latency.valid(), "Search percentiles are malformed");
        } else {
            ensure!(
                record["storeBytes"].as_u64().is_some_and(|value| value > 0),
                "The saved store wasn't measured"
            );
        }
        records.push(record);
    }
    require_current_sources(root, &source)?;
    let record = json!({"result":"passed", "target":TARGET, "sdk":sdk,
        "swift":String::from_utf8(compiler_version.stdout)?, "runtime":super::RUNTIME,
        "scope":"Optimized production search and offline bundled import in separate command-line processes on the checkout's booted iOS Simulator; excludes installed-app cold launch and physical iPhone performance; resident peaks include the ranking fixture.",
        "fixtureSha256":crate::sha256_hex(fs::read(root.join("tests/fixtures/search-ranking.json"))?),
        "source_sha256":source_records(&source), "measurements":records});
    fs::write(
        directory.join("report.json"),
        serde_json::to_vec_pretty(&record)?,
    )?;
    println!(
        "PASS: optimized Simulator search, 2,200 complete rankings, offline national import, resident peaks, and store bytes measured"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_reject_negative_nonfinite_and_reversed_measurements() {
        let valid = Latency {
            p50: 1.0,
            p95: 2.0,
            p99: 3.0,
            maximum: 4.0,
        };
        assert!(valid.valid());
        for values in [
            [-1.0, 2.0, 3.0, 4.0],
            [2.0, 1.0, 3.0, 4.0],
            [1.0, 2.0, 5.0, 4.0],
            [1.0, 2.0, 3.0, f64::NAN],
        ] {
            assert!(
                !Latency {
                    p50: values[0],
                    p95: values[1],
                    p99: values[2],
                    maximum: values[3]
                }
                .valid()
            );
        }
    }
}
