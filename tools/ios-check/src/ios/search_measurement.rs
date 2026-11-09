use super::{device, logged, require_current_sources, source_hashes, source_records};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{fs, path::Path, process::Command};

const APP_REPETITIONS: usize = 5;
const MEMORY_REPETITIONS: usize = 3;
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
        APP_REPETITIONS,
    )
}

fn case_metrics(
    bytes: &[u8],
    name: &str,
    required_families: &[&str],
    repetitions: usize,
) -> Result<Vec<AppMetric>> {
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
            && metric.measurements.len() == repetitions
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
        case_metrics(&bytes, case, &["memory"], MEMORY_REPETITIONS)?
    };
    super::bundled::check_built(root, &root.join("ios/DerivedData/Build/Products/VerificationRelease-iphonesimulator/PublicPhonebook.app"), "VerificationRelease")?;
    ensure!(!metrics.is_empty(), "The app measurement is empty");
    Ok(
        json!({"configuration":"VerificationRelease", "test":case, "repetitions":if case == super::STARTUP_UI_TEST { APP_REPETITIONS } else { MEMORY_REPETITIONS },
        "scope":"Startup measures process relaunch from the saved national generation to the search hint; the memory case searches four national queries per repetition; first setup is outside each timer; filesystem caches are uncontrolled; physical iPhone performance is unmeasured.",
        "budgets":{"maximumStartupSeconds":MAXIMUM_APP_STARTUP_SECONDS,"maximumPhysicalMemoryBytes":MAXIMUM_APP_MEMORY_BYTES,"kilobyteInterpretation":"Conservative 1024 bytes per reported kB", "startup":metric_budget(&metrics,"clock","s",MAXIMUM_APP_STARTUP_SECONDS),"memory":metric_budget(&metrics,"memory","kB",MAXIMUM_APP_KILOBYTES)},
        "resultBundle":bundle.strip_prefix(root).context("App result is outside the checkout")?, "metrics":metrics}),
    )
}

pub(super) fn run(root: &Path) -> Result<()> {
    let sources = source_hashes(root)?;
    let directory = root.join("target/ios/search-measurements");
    fs::create_dir_all(&directory)?;
    let simulator = device(root)?;
    let startup = measure_app(root, simulator.id(), &directory, super::STARTUP_UI_TEST)?;
    let memory = measure_app(
        root,
        simulator.id(),
        &directory,
        super::SEARCH_MEMORY_UI_TEST,
    )?;
    require_current_sources(root, &sources)?;
    fs::write(
        directory.join("report.json"),
        serde_json::to_vec_pretty(&json!({
            "result":"measured",
            "configuration":"VerificationRelease",
            "runtime":super::RUNTIME,
            "scope":"Installed literal-search app; five launches from a saved national generation and three four-query memory repetitions; physical iPhone performance is unmeasured.",
            "source_sha256":source_records(&sources),
            "installedApp":startup,
            "installedAppSearch":memory
        }))?,
    )?;
    println!(
        "PASS: optimized installed-app measurements; five startup repetitions and three literal-search memory repetitions; inspect report.json for budget verdicts"
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
    fn app_measurements_require_the_named_case_five_samples_and_each_metric_family() -> Result<()> {
        let valid = json!([{"testIdentifier":super::super::STARTUP_UI_TEST,"testRuns":[{"metrics":[
            {"displayName":"Clock","unitOfMeasurement":"s","measurements":[1.0,2.0,3.0,4.0,5.0],"identifier":"clock"},
            {"displayName":"Memory","unitOfMeasurement":"kB","measurements":[1.0,2.0,3.0,4.0,5.0],"identifier":"memory"},
            {"displayName":"Launch","unitOfMeasurement":"s","measurements":[1.0,2.0,3.0,4.0,5.0],"identifier":"launch"}
        ]}]}]);
        assert_eq!(app_metrics(&serde_json::to_vec(&valid)?)?.len(), 3);
        let mut missing = valid.clone();
        missing[0]["testRuns"][0]["metrics"]
            .as_array_mut()
            .context("metrics")?
            .pop();
        assert!(app_metrics(&serde_json::to_vec(&missing)?).is_err());
        let mut short = valid.clone();
        short[0]["testRuns"][0]["metrics"][0]["measurements"] = json!([1.0]);
        assert!(app_metrics(&serde_json::to_vec(&short)?).is_err());
        let mut three = valid.clone();
        three[0]["testRuns"][0]["metrics"][0]["measurements"] = json!([1.0, 2.0, 3.0]);
        assert!(app_metrics(&serde_json::to_vec(&three)?).is_err());
        let mut zero = valid.clone();
        zero[0]["testRuns"][0]["metrics"][1]["measurements"] = json!(vec![0.0; APP_REPETITIONS]);
        assert!(app_metrics(&serde_json::to_vec(&zero)?).is_err());
        Ok(())
    }
}
