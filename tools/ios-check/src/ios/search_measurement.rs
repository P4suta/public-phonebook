use super::{device, logged, require_current_sources, source_hashes, source_records};
use anyhow::{Context, Result, ensure};
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
const APP_REPETITIONS: usize = 3;
const MAXIMUM_APP_STARTUP_SECONDS: f64 = 1.0;
const MAXIMUM_APP_MEMORY_BYTES: f64 = 250_000_000.0;
const CONSERVATIVE_BYTES_PER_KILOBYTE: f64 = 1024.0;
const MAXIMUM_APP_KILOBYTES: f64 = MAXIMUM_APP_MEMORY_BYTES / CONSERVATIVE_BYTES_PER_KILOBYTE;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppMetric {
    display_name: String,
    unit_of_measurement: String,
    measurements: Vec<f64>,
    identifier: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppRun {
    metrics: Vec<AppMetric>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppCase {
    test_identifier: String,
    test_runs: Vec<AppRun>,
}

fn app_metrics(bytes: &[u8]) -> Result<Vec<AppMetric>> {
    case_metrics(
        bytes,
        super::STARTUP_UI_TEST,
        &["clock", "memory", "launch"],
    )
}

fn case_metrics(bytes: &[u8], name: &str, required_families: &[&str]) -> Result<Vec<AppMetric>> {
    let cases: Vec<AppCase> = serde_json::from_slice(bytes)?;
    let [case] = cases.as_slice() else {
        anyhow::bail!("The app measurement must contain one test case");
    };
    ensure!(
        case.test_identifier.contains(name),
        "The app measurement names another test"
    );
    let metrics = cases
        .into_iter()
        .flat_map(|case| case.test_runs)
        .flat_map(|run| run.metrics)
        .collect::<Vec<_>>();
    ensure!(
        metrics.iter().all(|metric| !metric.display_name.is_empty()
            && !metric.unit_of_measurement.is_empty()
            && metric.measurements.len() == APP_REPETITIONS
            && metric.measurements.iter().all(|value| value.is_finite())),
        "The app metrics omit finite repetitions or units"
    );
    for required in required_families {
        ensure!(
            metrics.iter().any(|metric| metric
                .identifier
                .as_deref()
                .unwrap_or(&metric.display_name)
                .to_ascii_lowercase()
                .contains(required)
                && metric.measurements.iter().all(|value| *value > 0.0)),
            "The app measurement omits {required}"
        );
    }
    Ok(metrics)
}

fn metric_budget(metrics: &[AppMetric], family: &str, unit: &str, maximum: f64) -> Option<bool> {
    let selected = metrics
        .iter()
        .filter(|metric| {
            let identifier = metric
                .identifier
                .as_deref()
                .unwrap_or(&metric.display_name)
                .to_ascii_lowercase();
            identifier.contains(family) && (family != "memory" || identifier.contains("peak"))
        })
        .collect::<Vec<_>>();
    if selected.is_empty()
        || selected
            .iter()
            .any(|metric| metric.unit_of_measurement != unit)
    {
        return None;
    }
    Some(selected.iter().all(|metric| {
        metric
            .measurements
            .iter()
            .all(|value| value.is_finite() && *value >= 0.0 && *value <= maximum)
    }))
}

fn measure_app(
    root: &Path,
    identifier: &str,
    directory: &Path,
    case: &str,
) -> Result<serde_json::Value> {
    let stem = if case == super::STARTUP_UI_TEST {
        "app-startup"
    } else {
        "app-search-memory"
    };
    let bundle = directory.join(format!("{stem}.xcresult"));
    if bundle.exists() {
        fs::remove_dir_all(&bundle)?;
    }
    logged(
        root,
        &format!("search-measure-{stem}"),
        super::ui_build_command(root, identifier, "VerificationRelease")
            .arg("-resultBundlePath")
            .arg(&bundle)
            .arg(format!(
                "-only-testing:PhonebookUITests/DirectoryUITests/{}",
                case
            ))
            .arg("test"),
    )?;
    let read = |kind| -> Result<serde_json::Value> {
        let output = logged(
            root,
            &format!("search-measure-{stem}-{kind}"),
            Command::new("xcrun")
                .args(["xcresulttool", "get", "test-results", kind, "--path"])
                .arg(&bundle),
        )?;
        Ok(serde_json::from_slice(&output.stdout)?)
    };
    super::require_ui_case(&read("summary")?, &read("tests")?, case)?;
    let bytes = serde_json::to_vec(&read("metrics")?)?;
    let metrics = if case == super::STARTUP_UI_TEST {
        app_metrics(&bytes)?
    } else {
        case_metrics(&bytes, case, &["memory"])?
    };
    super::bundled::check_built(root, &root.join("ios/DerivedData/Build/Products/VerificationRelease-iphonesimulator/PublicPhonebook.app"), "VerificationRelease")?;
    ensure!(!metrics.is_empty(), "The app measurement is empty");
    Ok(
        json!({"configuration":"VerificationRelease", "test":case, "repetitions":APP_REPETITIONS,
        "scope":"Startup measures process relaunch from the saved national generation to the search hint; the memory case searches four national queries per repetition; first setup is outside each timer; filesystem caches are uncontrolled; XCTest target-app physical memory differs from command-line resident peaks.",
        "budgets":{"maximumStartupSeconds":MAXIMUM_APP_STARTUP_SECONDS,"maximumPhysicalMemoryBytes":MAXIMUM_APP_MEMORY_BYTES,"kilobyteInterpretation":"Conservative 1024 bytes per reported kB", "startup":metric_budget(&metrics,"clock","s",MAXIMUM_APP_STARTUP_SECONDS),"memory":metric_budget(&metrics,"memory","kB",MAXIMUM_APP_KILOBYTES)},
        "resultBundle":bundle.strip_prefix(root).context("App result is outside the checkout")?, "metrics":metrics}),
    )
}

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
    for (module, links) in [
        ("PhonebookCore", &[][..]),
        ("PhonebookRanking", &["-lPhonebookCore"][..]),
        (
            "PhonebookKit",
            &["-lPhonebookCore", "-lPhonebookRanking", "-lsqlite3"][..],
        ),
    ] {
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
            .args(sources(root, module)?)
            .args(links);
        logged(root, &format!("search-compile-{module}"), &mut command)?;
    }
    let binary = directory.join("search-measurements");
    logged(
        root,
        "search-compile-measurement",
        compiler(root, &directory, &sdk)
            .args([
                "-lPhonebookCore",
                "-lPhonebookRanking",
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
    let saved_store = directory.join("saved-store");
    if saved_store.exists() {
        fs::remove_dir_all(&saved_store)?;
    }
    for mode in ["core", "import", "saved"] {
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
        if mode != "import" {
            ensure!(
                record["comparedQueries"] == FIXTURE_QUERIES,
                "Search measurement omitted rankings"
            );
            let latency: Latency = serde_json::from_value(record["latencyMilliseconds"].clone())?;
            ensure!(latency.valid(), "Search percentiles are malformed");
        }
        if mode != "core" {
            ensure!(
                record["storeBytes"].as_u64().is_some_and(|value| value > 0),
                "The saved store wasn't measured"
            );
        }
        records.push(record);
    }
    let app = measure_app(root, simulator.id(), &directory, super::STARTUP_UI_TEST)?;
    let app_search = measure_app(
        root,
        simulator.id(),
        &directory,
        super::SEARCH_MEMORY_UI_TEST,
    )?;
    require_current_sources(root, &source)?;
    let record = json!({"result":"passed", "target":TARGET, "sdk":sdk,
        "swift":String::from_utf8(compiler_version.stdout)?, "runtime":super::RUNTIME,
        "scope":"Optimized core search, offline import, and saved-generation reopening in separate command-line Simulator processes, plus VerificationRelease app relaunch to search readiness; physical iPhone performance is unmeasured; command-line resident peaks include the ranking fixture and row-mapping validation.",
        "fixtureSha256":crate::sha256_hex(fs::read(root.join("tests/fixtures/search-ranking.json"))?),
        "source_sha256":source_records(&source), "measurements":records, "installedApp":app, "installedAppSearch":app_search});
    fs::write(
        directory.join("report.json"),
        serde_json::to_vec_pretty(&record)?,
    )?;
    println!(
        "PASS: optimized Simulator search, 2,200 complete rankings, offline national import, resident peaks, store bytes, and three installed-app startup measurements"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_budgets_require_measured_units_and_reject_an_exceeded_peak() {
        let mut metrics = vec![AppMetric {
            display_name: "Memory Peak Physical".into(),
            unit_of_measurement: "kB".into(),
            measurements: vec![MAXIMUM_APP_KILOBYTES; APP_REPETITIONS],
            identifier: Some("physical_memory_peak".into()),
        }];
        metrics.push(AppMetric {
            display_name: "Memory Physical".into(),
            unit_of_measurement: "kB".into(),
            measurements: vec![-1.0; APP_REPETITIONS],
            identifier: Some("physical_memory".into()),
        });
        assert_eq!(
            metric_budget(&metrics, "memory", "kB", MAXIMUM_APP_KILOBYTES),
            Some(true)
        );
        metrics[0].measurements[0] += 1.0;
        assert_eq!(
            metric_budget(&metrics, "memory", "kB", MAXIMUM_APP_KILOBYTES),
            Some(false)
        );
        metrics[0].unit_of_measurement = "MB".into();
        assert_eq!(
            metric_budget(&metrics, "memory", "kB", MAXIMUM_APP_KILOBYTES),
            None
        );
        assert_eq!(
            metric_budget(&[], "clock", "s", MAXIMUM_APP_STARTUP_SECONDS),
            None
        );
        assert_eq!(
            metric_budget(&metrics[1..], "memory", "kB", MAXIMUM_APP_KILOBYTES),
            None
        );
    }

    #[test]
    fn app_measurements_require_the_named_case_three_samples_and_each_metric_family() -> Result<()>
    {
        let valid = json!([{"testIdentifier":super::super::STARTUP_UI_TEST,"testRuns":[{"metrics":[
            {"displayName":"Clock","unitOfMeasurement":"s","measurements":[1.0,2.0,3.0],"identifier":"clock"},
            {"displayName":"Memory","unitOfMeasurement":"kB","measurements":[1.0,2.0,3.0],"identifier":"memory"},
            {"displayName":"Launch","unitOfMeasurement":"s","measurements":[1.0,2.0,3.0],"identifier":"launch"}
        ]}]}]);
        assert_eq!(
            app_metrics(&serde_json::to_vec(&valid)?)?.len(),
            APP_REPETITIONS
        );
        let mut missing = valid.clone();
        missing[0]["testRuns"][0]["metrics"]
            .as_array_mut()
            .context("metrics")?
            .pop();
        assert!(app_metrics(&serde_json::to_vec(&missing)?).is_err());
        let mut short = valid.clone();
        short[0]["testRuns"][0]["metrics"][0]["measurements"] = json!([1.0]);
        assert!(app_metrics(&serde_json::to_vec(&short)?).is_err());
        let mut zero = valid.clone();
        zero[0]["testRuns"][0]["metrics"][1]["measurements"] = json!([0.0, 0.0, 0.0]);
        assert!(app_metrics(&serde_json::to_vec(&zero)?).is_err());
        Ok(())
    }

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
