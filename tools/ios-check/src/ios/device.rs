//! Records the first run's measurements and walks the on-device checks on one connected iPhone.
//! The step meter counts this tool's own processes; the device numbers come only from the XCTest metrics.

use super::{bundled, logged};
use crate::locations::CODESIGN;
use crate::locations::PRODUCTION_ORIGIN;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fmt::Write as _,
    fs,
    io::{self, BufRead, IsTerminal, Write},
    path::Path,
    process::Command,
};

const DEVICES: &str = "target/ios/device/devices.json";
/// The measurement test bundle copies this folder, so a run replays what the service listed.
const MEASUREMENT_INPUTS: &str = "target/ios/device-measurement";
const REPLAY: &str = "replay.json";
const RESULT_BUNDLE: &str = "target/ios/device/measurements.xcresult";
const ATTACHMENTS: &str = "target/ios/device/attachments";
const CRASH_LOGS: &str = "target/ios/device/crash-logs";
const DERIVED_DATA: &str = "target/ios/device/DerivedData";
const BUILT_APP: &str = "Build/Products/VerificationRelease-iphoneos/PublicPhonebook.app";
const RECORD: &str = "target/ios/device-record.json";
const SCHEME: &str = "PublicPhonebookDeviceMeasurements";
const TEST_CLASS: &str = "PhonebookDeviceMeasurements/DeviceMeasurementTests";
const CONFIGURATION: &str = "VerificationRelease";
const BUNDLE_IDENTIFIER: &str = "page.dial.publicphonebook.devicechecks";
const QA_DIRECTORY: &str = "target/ios/qa-install";
const QA_DERIVED_DATA: &str = "target/ios/qa-install/DerivedData";
const UI_DIRECTORY: &str = "target/ios/device-ui";
const LOCAL_SIGNING: &str = "apps/ios/Signing.local.xcconfig";
const QA_SCHEME: &str = "PublicPhonebookVerification";
const LISTING_PATH: &str = "/api/datasets";
const DELTA_LISTING_PREFIX: &str = "/api/dataset-deltas?";
const DATASET_PREFIX: &str = "/api/datasets/";
const DELTA_FORMAT: &str = "public-phonebook-directory-delta/1";
/// The largest JSON body that the app reads, which bounds each recorded listing too.
const LISTING_LIMIT: u64 = 8_388_608;
/// The largest dataset file that the app reads.
const DATASET_LIMIT: u64 = 268_435_456;
const SHA256_HEX_LENGTH: usize = 64;
/// `0xdead10cc`, which ends an app that iOS suspends while it holds a file or SQLite lock, in hexadecimal and decimal.
const DEADLOCK_CODES: [&str; 2] = ["dead10cc", "3735883980"];
const CRASH_REPORT_EXTENSION: &str = "ips";
const MEASUREMENT_PREFIX: &str = "measurement-";
const INSTRUCTIONS_SUFFIX: &str = "instructions_retired";
/// An unclear answer is asked again this many times before the item stays pending.
const ANSWER_ATTEMPTS: usize = 3;
const PENDING: &str = "pending";
/// Values from this size up print as grouped whole numbers, and smaller ones keep three decimals.
const GROUPED_FROM: f64 = 1_000.0;
const DIGITS_PER_GROUP: usize = 3;

/// The three first-run paths of #231, each with the test that measures it and whether it needs a delta.
const RUN_PATHS: [(&str, &str, bool); 3] = [
    ("bundledImport", "testBundledImport", false),
    ("deltaFromTheBundle", "testDeltaFromTheBundle", true),
    ("bundleThenDelta", "testBundleThenDeltaFromTheStore", true),
];

/// The on-device checks of `docs/ios-device-verification.md` and #253, each with what to do and observe.
const ON_DEVICE_ITEMS: [(&str, &str); 12] = [
    (
        "read-only search",
        "Run only PhonebookUITests/DirectoryUITests/testLivePublicDirectorySearchAndSource on this iPhone.",
    ),
    (
        "forced background launch",
        "From LLDB, launch the refresh task with the app in the background, and watch the handler, requests, activation, and result.",
    ),
    (
        "forced background expiry",
        "Serve PHONEBOOK_FIXTURE_INCOMPLETE=datasets, expire the task from LLDB once real I/O begins, and check the cancellation and the kept generation.",
    ),
    (
        "natural background delivery",
        "Detach the debugger, leave a due request, and watch a stated window, where no delivery is inconclusive.",
    ),
    (
        "incoming caller name",
        "Save the controlled line's number on the QA screen, call the iPhone from it, check the label, and press 消す afterward.",
    ),
    (
        "changed caller label",
        "Change only the saved test number's label, and check the new label on an incoming call and the caller.load line.",
    ),
    (
        "caller numbers out of order",
        "Save a test number below every national number and then one above them, and record each caller.load line.",
    ),
    (
        "one generation newer",
        "Install a generation one step newer than the loaded one, and compare its load time with a full load of 561,495 entries.",
    ),
    (
        "extension off and on",
        "Turn the Call Directory extension off and on, and check removed=0 and the full entry count on the next load.",
    ),
    (
        "caller load left early",
        "Leave the app while a load runs, and check that the load after expired=true sends the same difference again.",
    ),
    (
        "app left during an import",
        "Start a first run, leave the app while it imports, and return, and the crash log check follows this item.",
    ),
    (
        "signposted intervals",
        "Profile a first run with the os_signpost instrument, and keep the trace beside this record.",
    ),
];

/// The one connected iPhone that a measurement runs on.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Device {
    identifier: String,
    udid: String,
    model: String,
    os: String,
    build: String,
}

fn text<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or("")
}

/// Whether `device` is a physical iPhone that matches the requested identifier or UDID, if any.
fn listed_iphone(device: &Value, requested: Option<&str>) -> bool {
    text(device, "/properties/hardware/reality") == "physical"
        && text(device, "/properties/hardware/platform") == "iOS"
        && text(device, "/properties/hardware/deviceType") == "iPhone"
        && requested.is_none_or(|wanted| {
            text(device, "/identifier") == wanted
                || text(device, "/properties/hardware/udid") == wanted
        })
}

/// The CoreDevice identifiers of the requested iPhones whose connection isn't open.
fn idle_iphones(report: &Value, requested: Option<&str>) -> Vec<String> {
    report
        .pointer("/result/devices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|device| {
            listed_iphone(device, requested)
                && text(device, "/properties/connection/state") != "connected"
        })
        .map(|device| text(device, "/identifier").to_owned())
        .collect()
}

/// Picks the connected iPhone, after asking CoreDevice once to open each idle iPhone's connection.
fn select_from(
    mut list: impl FnMut() -> Result<Value>,
    mut wake: impl FnMut(&str),
    requested: Option<&str>,
) -> Result<Device> {
    let report = list()?;
    if let Ok(device) = connected_iphone(&report, requested) {
        return Ok(device);
    }
    for identifier in idle_iphones(&report, requested) {
        wake(&identifier);
    }
    connected_iphone(&list()?, requested)
}

/// Picks the one connected iPhone in a `devicectl list devices` report, or refuses with what's missing.
fn connected_iphone(report: &Value, requested: Option<&str>) -> Result<Device> {
    let devices = report
        .pointer("/result/devices")
        .and_then(Value::as_array)
        .context("devicectl reported no device list")?;
    let phones = devices
        .iter()
        .filter(|device| listed_iphone(device, requested))
        .collect::<Vec<_>>();
    let Some(first) = phones.first() else {
        anyhow::bail!(
            "{}",
            requested.map_or_else(
                || "No iPhone is connected. Connect one by cable, unlock it, trust this Mac, turn on Developer Mode, and run `just ios-device-record` again.".to_owned(),
                |wanted| format!("No paired iPhone has the identifier {wanted}."),
            )
        );
    };
    let connected = phones
        .iter()
        .filter(|device| text(device, "/properties/connection/state") == "connected")
        .collect::<Vec<_>>();
    ensure!(
        !connected.is_empty(),
        "No iPhone is connected. {} is paired but {} after a request to open its connection, so unlock it, keep it near this Mac, and run `just ios-device-record` again.",
        text(first, "/properties/hardware/marketingName"),
        match text(first, "/properties/connection/state") {
            "" => "unavailable",
            state => state,
        }
    );
    ensure!(
        connected.len() == 1,
        "{} iPhones are connected; choose one with --device and one of these identifiers: {}.",
        connected.len(),
        connected
            .iter()
            .map(|device| text(device, "/properties/hardware/udid"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let device = connected[0];
    ensure!(
        device
            .pointer("/properties/state/developerModeStatus/enabled")
            .is_some(),
        "{} has Developer Mode off; turn it on in Settings > Privacy & Security, and run `just ios-device-record` again.",
        text(device, "/properties/hardware/marketingName")
    );
    Ok(Device {
        identifier: text(device, "/identifier").to_owned(),
        udid: text(device, "/properties/hardware/udid").to_owned(),
        model: text(device, "/properties/hardware/marketingName").to_owned(),
        os: text(device, "/properties/software/osVersionNumber/stringValue").to_owned(),
        build: text(
            device,
            "/properties/software/osBuildVersions/buildVersion/name",
        )
        .to_owned(),
    })
}

/// A delta file that the service lists from the bundled snapshot.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct DeltaFile {
    url: String,
    sha256: String,
    bytes: u64,
}

/// What the service offers for the two delta paths of a measurement.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum DeltaInput {
    Published(DeltaFile),
    /// The service still lists the bundled snapshot, so no delta from it exists.
    Current,
    /// The service lists another snapshot without a delta from the bundled one.
    Unlisted,
}

fn hex64(text: &str) -> bool {
    text.len() == SHA256_HEX_LENGTH
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Picks the listed delta whose base is the bundled snapshot.
fn select_delta(listing: &Value, deltas: Option<&Value>, bundled: &str) -> Result<DeltaInput> {
    let snapshot = listing["snapshot"]
        .as_str()
        .context("The listing names no snapshot")?;
    if snapshot == bundled {
        return Ok(DeltaInput::Current);
    }
    let Some(deltas) = deltas else {
        return Ok(DeltaInput::Unlisted);
    };
    ensure!(
        deltas["snapshot"].as_str() == Some(snapshot),
        "The delta listing names another snapshot than the listing"
    );
    let entries = deltas["deltas"]
        .as_array()
        .context("The delta listing has no deltas")?;
    let Some(entry) = entries.iter().find(|entry| {
        entry["format"].as_str() == Some(DELTA_FORMAT) && entry["base"].as_str() == Some(bundled)
    }) else {
        return Ok(DeltaInput::Unlisted);
    };
    let url = entry["url"].as_str().context("The delta has no URL")?;
    let sha256 = entry["sha256"]
        .as_str()
        .context("The delta has no SHA-256")?;
    let bytes = entry["bytes"].as_u64().context("The delta has no length")?;
    ensure!(
        url.starts_with(DATASET_PREFIX)
            && !url.contains("..")
            && !url.contains('?')
            && hex64(sha256)
            && (1..=DATASET_LIMIT).contains(&bytes),
        "The listed delta is malformed"
    );
    Ok(DeltaInput::Published(DeltaFile {
        url: url.to_owned(),
        sha256: sha256.to_owned(),
        bytes,
    }))
}

/// Each path with its test, and why it waits, or `None` when it runs.
fn planned_paths(delta: &DeltaInput) -> [(&'static str, &'static str, Option<&'static str>); 3] {
    RUN_PATHS.map(|(path, test, needs_delta)| {
        let pending = match (needs_delta, delta) {
            (false, _) | (true, DeltaInput::Published(_)) => None,
            (true, DeltaInput::Current) => {
                Some("the service still lists the bundled snapshot, so no delta from it exists")
            }
            (true, DeltaInput::Unlisted) => {
                Some("the service lists no delta from the bundled snapshot")
            }
        };
        (path, test, pending)
    })
}

/// The median of the measured values, or `None` without a value.
fn median(values: &[f64]) -> Option<f64> {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    match sorted.len() {
        0 => None,
        count if count % 2 == 1 => Some(sorted[middle]),
        _ => Some(f64::midpoint(sorted[middle - 1], sorted[middle])),
    }
}

fn counts_instructions(metric: &Value) -> bool {
    text(metric, "/identifier").ends_with(INSTRUCTIONS_SUFFIX)
}

/// Reads one measurement attachment into its metric medians and store sizes.
fn measurement(attachment: &Value) -> Result<Value> {
    let path = attachment["path"]
        .as_str()
        .filter(|path| RUN_PATHS.iter().any(|(known, _, _)| known == path))
        .context("A measurement names an unknown path")?;
    let metrics = attachment["metrics"]
        .as_array()
        .context("A measurement has no metrics")?
        .iter()
        .map(|metric| {
            let values = metric["values"]
                .as_array()
                .context("A metric has no values")?
                .iter()
                .map(|value| value.as_f64().context("A metric value is not a number"))
                .collect::<Result<Vec<_>>>()?;
            Ok(json!({
                "identifier": metric["identifier"].as_str().context("A metric has no identifier")?,
                "name": text(metric, "/name"),
                "unit": text(metric, "/unit"),
                "median": median(&values).context("A metric has no values")?,
                "values": values,
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        metrics.iter().any(counts_instructions),
        "The {path} measurement has no instructions retired"
    );
    let stores = attachment["storeBytes"]
        .as_array()
        .context("A measurement has no store sizes")?;
    ensure!(
        !stores.is_empty() && stores.iter().all(Value::is_u64),
        "The {path} measurement has no store sizes"
    );
    Ok(json!({"path": path, "metrics": metrics, "storeBytes": stores}))
}

fn native_measurement(attachment: &Value, results: &Value) -> Result<Value> {
    let path = text(attachment, "/path");
    let (_, test, _) = RUN_PATHS
        .iter()
        .find(|(known, _, _)| *known == path)
        .context("A measurement names an unknown path")?;
    let identifier = format!("DeviceMeasurementTests/{test}()");
    let matching = results
        .as_array()
        .context("Native metrics are not a list")?
        .iter()
        .filter(|case| text(case, "/testIdentifier") == identifier)
        .collect::<Vec<_>>();
    let [case] = matching.as_slice() else {
        anyhow::bail!("A measurement needs exactly its named native case");
    };
    let runs = case["testRuns"]
        .as_array()
        .context("A native case has no test runs")?;
    let [run] = runs.as_slice() else {
        anyhow::bail!("A native measurement needs one device run");
    };
    let repetitions = attachment["iterations"]
        .as_u64()
        .filter(|count| *count > 0)
        .context("A measurement has no positive iteration count")?;
    let repetitions = usize::try_from(repetitions)?;
    let metrics = run["metrics"]
        .as_array()
        .context("A native case has no metrics")?
        .iter()
        .map(|metric| {
            let identifier = metric["identifier"]
                .as_str()
                .filter(|value| !value.is_empty())
                .context("A native metric has no identifier")?;
            let name = metric["displayName"]
                .as_str()
                .filter(|value| !value.is_empty())
                .context("A native metric has no name")?;
            let unit = metric["unitOfMeasurement"]
                .as_str()
                .filter(|value| !value.is_empty())
                .context("A native metric has no unit")?;
            let values = metric["measurements"]
                .as_array()
                .context("A native metric has no values")?;
            ensure!(
                values.len() == repetitions
                    && values
                        .iter()
                        .all(|value| value.as_f64().is_some_and(f64::is_finite)),
                "A native metric has incomplete finite repetitions"
            );
            Ok(json!({"identifier":identifier,"name":name,"unit":unit,"values":values}))
        })
        .collect::<Result<Vec<_>>>()?;
    for (family, unit) in [
        ("cpu.instructions_retired", "kI"),
        ("clock.time.monotonic", "s"),
        ("memory.physical_peak", "kB"),
        ("disk.logical_writes", "kB"),
    ] {
        ensure!(
            metrics.iter().any(|metric| text(metric, "/identifier")
                .to_ascii_lowercase()
                .ends_with(family)
                && text(metric, "/unit") == unit
                && metric["values"].as_array().is_some_and(|values| values
                    .iter()
                    .all(|value| value.as_f64().is_some_and(|value| value > 0.0)))),
            "Native metrics omit positive {family} repetitions"
        );
    }
    let mut measured =
        measurement(&json!({"path":path,"metrics":metrics,"storeBytes":attachment["storeBytes"]}))?;
    let observations = attachment["observations"]
        .as_array()
        .context("A measurement has no phase observations")?;
    let stores = measured["storeBytes"]
        .as_array()
        .context("Measured stores")?;
    ensure!(
        stores.len() >= repetitions
            && stores
                .iter()
                .all(|value| value.as_u64().is_some_and(|bytes| bytes > 0))
            && observations.len() == stores.len(),
        "A measurement needs phase observations and positive sizes for every trial"
    );
    let imports = if path == "bundleThenDelta" { 2 } else { 1 };
    for observation in observations {
        let intervals = observation["intervals"]
            .as_array()
            .context("An observation has no phase intervals")?;
        for stage in [1, 2] {
            ensure!(
                intervals
                    .iter()
                    .filter(|item| item["stage"] == stage)
                    .count()
                    == imports,
                "An observation omits a measured import stage"
            );
        }
        ensure!(
            intervals.len() == imports * 2
                && intervals
                    .iter()
                    .all(|item| item["rows"].as_u64().is_some_and(|rows| rows > 0)
                        && item["milliseconds"]
                            .as_f64()
                            .is_some_and(|ms| ms.is_finite() && ms > 0.0)),
            "An observation has invalid phase sizes or times"
        );
    }
    let space = &attachment["space"];
    let working = space["observedPeakWorkingBytes"]
        .as_u64()
        .context("No workspace sample")?;
    let scratch = space["observedPeakScratchBytes"]
        .as_u64()
        .context("No scratch sample")?;
    let stored = space["finalStoreBytes"]
        .as_u64()
        .context("No final store size")?;
    ensure!(
        stored > 0
            && working >= stored
            && working >= scratch
            && space["samples"].as_u64().is_some_and(|samples| samples > 0),
        "A measurement has incomplete workspace samples"
    );
    let allocated_working = space["observedPeakWorkingAllocatedBytes"]
        .as_u64()
        .context("No allocated workspace sample")?;
    let allocated_scratch = space["observedPeakScratchAllocatedBytes"]
        .as_u64()
        .context("No allocated scratch sample")?;
    let allocated_stored = space["finalStoreAllocatedBytes"]
        .as_u64()
        .context("No allocated store size")?;
    ensure!(
        allocated_stored > 0
            && allocated_working >= allocated_stored
            && allocated_working >= allocated_scratch,
        "A measurement has incomplete allocated storage samples"
    );
    measured["iterations"] = json!(repetitions);
    measured["observations"] = attachment["observations"].clone();
    measured["space"] = space.clone();
    Ok(measured)
}

fn device_unlocked(report: &Value) -> bool {
    report
        .pointer("/result/passcodeRequired")
        .and_then(Value::as_bool)
        == Some(false)
}

fn require_unlocked(root: &Path, device: &Device) -> Result<()> {
    let path = root.join("target/ios/device/lock-state.json");
    logged(
        root,
        "device-lock-state",
        Command::new("xcrun")
            .args([
                "devicectl",
                "device",
                "info",
                "lockState",
                "--device",
                &device.udid,
                "--quiet",
                "--json-output",
            ])
            .arg(&path),
    )?;
    ensure!(
        device_unlocked(&serde_json::from_slice(&fs::read(path)?)?),
        "Unlock {} before preparing the device check",
        device.model
    );
    Ok(())
}

/// The names of the crash reports for `bundle` that record a `0xdead10cc` termination.
fn deadlock_reports(reports: &[(String, String)], bundle: &str) -> Vec<String> {
    reports
        .iter()
        .filter(|(_, contents)| {
            let (header, body) = contents.split_once('\n').unwrap_or((contents, ""));
            serde_json::from_str::<Value>(header)
                .is_ok_and(|header| header["bundleID"].as_str() == Some(bundle))
                && DEADLOCK_CODES
                    .iter()
                    .any(|code| body.to_ascii_lowercase().contains(code))
        })
        .map(|(name, _)| name.clone())
        .collect()
}

/// The outcome that an answer names, by its first letter or the whole word.
fn outcome(answer: &str) -> Option<&'static str> {
    match answer.trim().to_ascii_lowercase().as_str() {
        "p" | "pass" | "passed" => Some("passed"),
        "f" | "fail" | "failed" => Some("failed"),
        "i" | "inconclusive" => Some("inconclusive"),
        "s" | "skip" | "pending" => Some(PENDING),
        _ => None,
    }
}

fn read_answer(input: &mut impl BufRead) -> Result<String> {
    let mut line = String::new();
    input.read_line(&mut line)?;
    Ok(line.trim().to_owned())
}

/// Walks each on-device item, asks for its outcome and a note, and keeps an item pending after unclear answers.
fn walk(input: &mut impl BufRead, output: &mut impl Write) -> Result<Vec<Value>> {
    let mut results = Vec::new();
    for (index, (item, instruction)) in ON_DEVICE_ITEMS.iter().enumerate() {
        writeln!(
            output,
            "[{}/{}] {item}: {instruction}",
            index + 1,
            ON_DEVICE_ITEMS.len()
        )?;
        let mut chosen = PENDING;
        for _ in 0..ANSWER_ATTEMPTS {
            write!(output, "Outcome (pass, fail, inconclusive, or skip): ")?;
            output.flush()?;
            if let Some(answer) = outcome(&read_answer(input)?) {
                chosen = answer;
                break;
            }
        }
        write!(output, "Note: ")?;
        output.flush()?;
        let note = read_answer(input)?;
        results.push(json!({"item": item, "outcome": chosen, "note": note}));
    }
    Ok(results)
}

fn number(value: f64) -> String {
    if value.abs() < GROUPED_FROM {
        return format!("{value:.3}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned();
    }
    let rounded = format!("{value:.0}");
    let (sign, digits) = rounded
        .strip_prefix('-')
        .map_or(("", rounded.as_str()), |digits| ("-", digits));
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % DIGITS_PER_GROUP == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    format!("{sign}{grouped}")
}

/// Writes the record as a section for `docs/ios-device-verification.md`.
fn record_markdown(record: &Value) -> Result<String> {
    let mut section = String::new();
    writeln!(
        section,
        "## Recorded measurement on {}\n",
        text(record, "/date")
    )?;
    writeln!(
        section,
        "The destination was {} with iOS {}, build {}, in the `{}` configuration.",
        text(record, "/device/model"),
        text(record, "/device/os"),
        text(record, "/device/build"),
        text(record, "/configuration")
    )?;
    if let Some(bytes) = record["appBytes"].as_u64() {
        writeln!(
            section,
            "The `{}` app for the device holds {} bytes.",
            text(record, "/configuration"),
            number(u64_to_f64(bytes))
        )?;
    }
    writeln!(
        section,
        "Each value is the median of the XCTest iterations.\n"
    )?;
    writeln!(section, "| Path | Metric | Median | Unit |")?;
    writeln!(section, "| --- | --- | --- | --- |")?;
    for path in record["paths"]
        .as_array()
        .context("The record has no paths")?
    {
        let name = text(path, "/path");
        if let Some(reason) = path["pending"].as_str() {
            writeln!(section, "| {name} | pending | {reason} | |")?;
            continue;
        }
        for metric in path["metrics"].as_array().into_iter().flatten() {
            writeln!(
                section,
                "| {name} | {} | {} | {} |",
                text(metric, "/name"),
                number(metric["median"].as_f64().unwrap_or_default()),
                text(metric, "/unit")
            )?;
        }
        if let Some(store) = path["storeBytes"]
            .as_array()
            .and_then(|stores| stores.last())
        {
            writeln!(
                section,
                "| {name} | saved store | {} | bytes |",
                number(u64_to_f64(store.as_u64().unwrap_or_default()))
            )?;
        }
    }
    writeln!(section, "\n| Check | Outcome | Note |")?;
    writeln!(section, "| --- | --- | --- |")?;
    for check in record["checks"]
        .as_array()
        .context("The record has no checks")?
    {
        writeln!(
            section,
            "| {} | {} | {} |",
            text(check, "/item"),
            text(check, "/outcome"),
            text(check, "/note").replace('|', "/")
        )?;
    }
    Ok(section)
}

/// A byte count as a float for display, saturating far above any app or store size.
fn u64_to_f64(value: u64) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}

fn bytes_under(directory: &Path) -> Result<u64> {
    let mut total = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        total += if kind.is_dir() {
            bytes_under(&entry.path())?
        } else {
            entry.metadata()?.len()
        };
    }
    Ok(total)
}

fn reports_under(directory: &Path, found: &mut Vec<(String, String)>) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            reports_under(&path, found)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == CRASH_REPORT_EXTENSION)
        {
            found.push((
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                String::from_utf8_lossy(&fs::read(&path)?).into_owned(),
            ));
        }
    }
    Ok(())
}

fn fresh(directory: &Path) -> Result<()> {
    if directory.exists() {
        fs::remove_dir_all(directory)?;
    }
    fs::create_dir_all(directory)?;
    Ok(())
}

/// Records the listing, the delta listing, and the delta from the bundled snapshot for the test bundle to replay.
fn record_inputs(root: &Path) -> Result<DeltaInput> {
    let inputs = root.join(MEASUREMENT_INPUTS);
    fresh(&inputs)?;
    let declaration: Value = serde_json::from_slice(&fs::read(root.join(bundled::NATIONAL))?)?;
    let bundled_snapshot = declaration["snapshot"]
        .as_str()
        .context("The bundled dataset declaration names no snapshot")?;
    let listing_file = inputs.join("datasets.json");
    bundled::download(
        root,
        &format!("{PRODUCTION_ORIGIN}{LISTING_PATH}"),
        &listing_file,
        LISTING_LIMIT,
    )?;
    let listing: Value = serde_json::from_slice(&fs::read(&listing_file)?)?;
    let link = listing["datasetDeltas"].as_str();
    let deltas = match link {
        Some(link) => {
            ensure!(
                link.starts_with(DELTA_LISTING_PREFIX) && !link.contains(".."),
                "The listing names a malformed delta listing"
            );
            let file = inputs.join("deltas.json");
            bundled::download(
                root,
                &format!("{PRODUCTION_ORIGIN}{link}"),
                &file,
                LISTING_LIMIT,
            )?;
            Some(serde_json::from_slice::<Value>(&fs::read(&file)?)?)
        }
        None => None,
    };
    let delta = select_delta(&listing, deltas.as_ref(), bundled_snapshot)?;
    let mut replay = Vec::new();
    if let (DeltaInput::Published(file), Some(link)) = (&delta, link) {
        let target = inputs.join("delta.tsv.br");
        bundled::download(
            root,
            &format!("{PRODUCTION_ORIGIN}{}", file.url),
            &target,
            file.bytes,
        )?;
        let bytes = fs::read(&target)?;
        ensure!(
            u64::try_from(bytes.len())? == file.bytes && crate::sha256_hex(&bytes) == file.sha256,
            "The delta differs from its listed length or SHA-256"
        );
        let snapshot = text(&listing, "/snapshot");
        replay = vec![
            json!({"path": LISTING_PATH, "type": "application/json", "snapshot": snapshot, "file": "datasets.json"}),
            json!({"path": link, "type": "application/json", "snapshot": snapshot, "file": "deltas.json"}),
            json!({"path": file.url, "type": "application/octet-stream", "snapshot": snapshot, "file": "delta.tsv.br"}),
        ];
    }
    fs::write(inputs.join(REPLAY), serde_json::to_vec_pretty(&replay)?)?;
    Ok(delta)
}

fn list(root: &Path) -> Result<Value> {
    logged(
        root,
        "device-list",
        Command::new("xcrun")
            .args([
                "devicectl",
                "list",
                "devices",
                "--quiet",
                "--omit-deprecated-fields-in-json",
                "--json-output",
            ])
            .arg(root.join(DEVICES)),
    )?;
    Ok(serde_json::from_slice(&fs::read(root.join(DEVICES))?)?)
}

/// Reading the details makes CoreDevice open an idle connection; a failed request leaves the phone idle for the next listing to report.
fn wake(root: &Path, identifier: &str) {
    if let Err(error) = logged(
        root,
        "device-wake",
        Command::new("xcrun").args([
            "devicectl",
            "device",
            "info",
            "details",
            "--quiet",
            "--device",
            identifier,
        ]),
    ) {
        eprintln!("Opening the connection of {identifier} failed: {error:#}");
    }
}

fn select(root: &Path, requested: Option<&str>) -> Result<Device> {
    fs::create_dir_all(root.join("target/ios/device"))?;
    let device = select_from(
        || list(root),
        |identifier| wake(root, identifier),
        requested,
    )?;
    println!(
        "Device: {} with iOS {}, build {}",
        device.model, device.os, device.build
    );
    Ok(device)
}

/// Refuses before any build unless one iPhone is ready, and records the service's delta inputs for the test bundle.
pub(super) fn prepare(root: &Path, requested: Option<&str>) -> Result<(Device, DeltaInput)> {
    let device = select(root, requested)?;
    require_unlocked(root, &device)?;
    Ok((device, record_inputs(root)?))
}

pub(super) fn prepare_qa(root: &Path, requested: Option<&str>) -> Result<Device> {
    let receipt = root.join(QA_DIRECTORY).join("receipt.json");
    if receipt.exists() {
        fs::remove_file(receipt)?;
    }
    ensure!(
        root.join(LOCAL_SIGNING).is_file(),
        "Create the ignored {LOCAL_SIGNING} with an authorized development team before installing QA"
    );
    let device = select(root, requested)?;
    require_unlocked(root, &device)?;
    Ok(device)
}

pub(super) fn prepare_ui(root: &Path, requested: Option<&str>) -> Result<Device> {
    let receipt = root.join(UI_DIRECTORY).join("receipt.json");
    if receipt.exists() {
        fs::remove_file(receipt)?;
    }
    prepare_qa(root, requested)
}

fn qa_command(root: &Path, device: &Device) -> Command {
    let mut command = Command::new("xcodebuild");
    command.current_dir(root).args([
        "-quiet",
        "-project",
        "apps/ios/PublicPhonebook.xcodeproj",
        "-scheme",
        QA_SCHEME,
        "-configuration",
        CONFIGURATION,
        "-destination",
        &format!("id={}", device.udid),
        "-derivedDataPath",
        QA_DERIVED_DATA,
        "-xcconfig",
        LOCAL_SIGNING,
        "-allowProvisioningUpdates",
        "-jobs",
        "2",
    ]);
    command
}

fn qa_build(root: &Path, device: &Device) -> Command {
    let mut command = qa_command(root, device);
    command.arg("build");
    command
}

fn smoke_command(root: &Path, device: &Device) -> Command {
    let mut command = qa_command(root, device);
    let allowance = super::SCENARIO_ALLOWANCE_SECONDS.to_string();
    command.args([
        "-only-testing:PhonebookUITests/DirectoryUITests/testLivePublicDirectorySearchAndSource",
        "-parallel-testing-enabled",
        "NO",
        "-maximum-concurrent-test-device-destinations",
        "1",
        "-test-timeouts-enabled",
        "YES",
        "-default-test-execution-time-allowance",
        &allowance,
        "-maximum-test-execution-time-allowance",
        &allowance,
        "-resultBundlePath",
        "target/ios/device-ui/search.xcresult",
        "test-without-building",
    ]);
    command
}

pub(super) fn smoke(root: &Path, device: &Device) -> Result<()> {
    let sources = super::source_hashes(root)?;
    let directory = root.join(UI_DIRECTORY);
    fresh(&directory)?;
    let mut build = qa_command(root, device);
    logged(root, "device-ui-build", build.arg("build-for-testing"))?;
    let app = root.join(QA_DERIVED_DATA).join(BUILT_APP);
    require_qa_build(root, &app)?;
    let bundle = directory.join("search.xcresult");
    let execution = logged(root, "device-ui", &mut smoke_command(root, device));
    let read_result = |kind| -> Result<Value> {
        let output = logged(
            root,
            &format!("device-ui-{kind}"),
            Command::new("xcrun")
                .args(["xcresulttool", "get", "test-results", kind, "--path"])
                .arg(&bundle),
        )?;
        Ok(serde_json::from_slice(&output.stdout)?)
    };
    execution?;
    super::require_ui_case(
        &read_result("summary")?,
        &read_result("tests")?,
        super::LIVE_UI_TEST,
    )?;
    super::require_current_sources(root, &sources)?;
    fs::write(
        directory.join("receipt.json"),
        serde_json::to_vec_pretty(&json!({
            "result":"passed", "configuration":CONFIGURATION, "bundleIdentifier":BUNDLE_IDENTIFIER,
            "version":super::plist_string(&app.join("Info.plist"), "CFBundleShortVersionString")?,
            "device":{"model":device.model,"os":device.os,"build":device.build},
            "test":super::LIVE_UI_TEST, "source_sha256":super::source_records(&sources),
        }))?,
    )?;
    println!(
        "PASS: read-only QA search, detail, and source on {} with iOS {}",
        device.model, device.os
    );
    Ok(())
}

fn installed_qa(report: &Value) -> Result<()> {
    ensure!(
        report.pointer("/info/outcome").and_then(Value::as_str) == Some("success"),
        "The installed-app read didn't succeed"
    );
    let apps = report
        .pointer("/result/apps")
        .and_then(Value::as_array)
        .context("The installed-app read has no apps")?;
    ensure!(
        apps.len() == 1 && apps[0]["bundleIdentifier"] == BUNDLE_IDENTIFIER,
        "The selected iPhone doesn't report the QA app as installed"
    );
    Ok(())
}

fn require_qa_build(root: &Path, app: &Path) -> Result<()> {
    ensure!(
        super::plist_string(&app.join("Info.plist"), "CFBundleIdentifier")? == BUNDLE_IDENTIFIER,
        "The build isn't the QA application identity"
    );
    bundled::check_built(root, app, CONFIGURATION)?;
    super::store_build::require_every_marker(app, CONFIGURATION)?;
    logged(
        root,
        "qa-signature",
        Command::new(CODESIGN)
            .args(["--verify", "--deep", "--strict"])
            .arg(app),
    )?;
    Ok(())
}

pub(super) fn install_qa(root: &Path, device: &Device) -> Result<()> {
    let sources = super::source_hashes(root)?;
    let directory = root.join(QA_DIRECTORY);
    fs::create_dir_all(&directory)?;
    logged(root, "qa-build", &mut qa_build(root, device))?;
    let app = root.join(QA_DERIVED_DATA).join(BUILT_APP);
    require_qa_build(root, &app)?;
    logged(
        root,
        "qa-install",
        Command::new("xcrun")
            .args([
                "devicectl",
                "device",
                "install",
                "app",
                "--device",
                &device.identifier,
                "--quiet",
                "--omit-deprecated-fields-in-json",
                "--json-output",
            ])
            .arg(directory.join("installation.json"))
            .arg(&app),
    )?;
    let listing = directory.join("installed-app.json");
    logged(
        root,
        "qa-installed-app",
        Command::new("xcrun")
            .args([
                "devicectl",
                "device",
                "info",
                "apps",
                "--device",
                &device.identifier,
                "--bundle-id",
                BUNDLE_IDENTIFIER,
                "--quiet",
                "--omit-deprecated-fields-in-json",
                "--json-output",
            ])
            .arg(&listing),
    )?;
    installed_qa(&serde_json::from_slice(&fs::read(listing)?)?)?;
    super::require_current_sources(root, &sources)?;
    let record = json!({"result":"installed", "configuration":CONFIGURATION, "bundleIdentifier":BUNDLE_IDENTIFIER,
        "device":{"model":device.model,"os":device.os,"build":device.build},
        "app":app.strip_prefix(root)?, "bundledDataset":"national", "signature":"verified",
        "source_sha256":super::source_records(&sources)});
    fs::write(
        directory.join("receipt.json"),
        serde_json::to_vec_pretty(&record)?,
    )?;
    println!(
        "PASS: {CONFIGURATION} QA app with the bundled national search installed on {} with iOS {}; open Public Phonebook QA on the iPhone",
        device.model, device.os
    );
    Ok(())
}

/// Measures the planned paths on the device, walks the on-device items, checks the crash logs, and writes the record.
pub(super) fn run(root: &Path, device: &Device, delta: &DeltaInput) -> Result<()> {
    let sources = super::source_hashes(root)?;
    let plan = planned_paths(delta);
    let bundle = root.join(RESULT_BUNDLE);
    if bundle.exists() {
        fs::remove_dir_all(&bundle)?;
    }
    let mut command = Command::new("xcodebuild");
    command.current_dir(root).args([
        "test",
        "-project",
        "apps/ios/PublicPhonebook.xcodeproj",
        "-scheme",
        SCHEME,
        "-configuration",
        CONFIGURATION,
        "-destination",
        &format!("id={}", device.udid),
        "-derivedDataPath",
        DERIVED_DATA,
        "-resultBundlePath",
        RESULT_BUNDLE,
        "-allowProvisioningUpdates",
    ]);
    for (_, test, pending) in plan {
        if pending.is_none() {
            command.arg(format!("-only-testing:{TEST_CLASS}/{test}"));
        }
    }
    command.arg("-only-testing:PhonebookDeviceMeasurements/CallerProbeTests");
    command.arg("-only-testing:PhonebookDeviceMeasurements/DirectoryStorageSizeTests");
    let measured = logged(root, "device-measure", &mut command);
    let restored = logged(
        root,
        "device-reopen-qa",
        Command::new("xcrun").args([
            "devicectl",
            "device",
            "process",
            "launch",
            "--device",
            &device.udid,
            "--terminate-existing",
            BUNDLE_IDENTIFIER,
        ]),
    );
    if let Err(error) = measured {
        return match restored {
            Ok(_) => Err(error),
            Err(restore) => {
                Err(error.context(format!("Restoring interactive QA also failed: {restore}")))
            }
        };
    }
    restored?;
    let metrics = logged(
        root,
        "device-native-metrics",
        Command::new("xcrun")
            .args(["xcresulttool", "get", "test-results", "metrics", "--path"])
            .arg(&bundle),
    )?;
    let metrics: Value = serde_json::from_slice(&metrics.stdout)?;
    let attachments = root.join(ATTACHMENTS);
    fresh(&attachments)?;
    logged(
        root,
        "device-attachments",
        Command::new("xcrun")
            .args(["xcresulttool", "export", "attachments", "--path"])
            .arg(&bundle)
            .arg("--output-path")
            .arg(&attachments),
    )?;
    let manifest: Value = serde_json::from_slice(&fs::read(attachments.join("manifest.json"))?)?;
    let mut measured = Vec::new();
    for attachment in manifest
        .as_array()
        .context("The attachment manifest is not a list")?
        .iter()
        .flat_map(|test| test["attachments"].as_array().into_iter().flatten())
        .filter(|attachment| {
            text(attachment, "/suggestedHumanReadableName").starts_with(MEASUREMENT_PREFIX)
        })
    {
        let file = text(attachment, "/exportedFileName");
        ensure!(
            !file.is_empty() && !file.contains('/') && !file.starts_with('.'),
            "Invalid exported attachment name"
        );
        measured.push(native_measurement(
            &serde_json::from_slice(&fs::read(attachments.join(file))?)?,
            &metrics,
        )?);
    }
    let paths = plan
        .iter()
        .map(|(path, _, pending)| match pending {
            Some(reason) => Ok(json!({"path": path, "pending": reason})),
            None => measured
                .iter()
                .find(|row| row["path"] == *path)
                .cloned()
                .with_context(|| format!("The device run recorded no {path} measurement")),
        })
        .collect::<Result<Vec<_>>>()?;
    let mut checks = if io::stdin().is_terminal() {
        walk(&mut io::stdin().lock(), &mut io::stdout())?
    } else {
        ON_DEVICE_ITEMS
            .iter()
            .map(|(item, _)| json!({"item": item, "outcome": PENDING, "note": "no terminal to answer"}))
            .collect()
    };
    let crash_logs = root.join(CRASH_LOGS);
    fresh(&crash_logs)?;
    logged(
        root,
        "device-crash-logs",
        Command::new("xcrun")
            .args(["devicectl", "device", "copy", "from", "--device"])
            .arg(&device.identifier)
            .args([
                "--domain-type",
                "systemCrashLogs",
                "--source",
                "/",
                "--destination",
            ])
            .arg(&crash_logs),
    )?;
    let mut reports = Vec::new();
    reports_under(&crash_logs, &mut reports)?;
    let deadlocks = deadlock_reports(&reports, BUNDLE_IDENTIFIER);
    checks.push(json!({
        "item": "no 0xdead10cc in the crash logs",
        "outcome": if deadlocks.is_empty() { "passed" } else { "failed" },
        "note": format!("{} crash reports read; {}", reports.len(), if deadlocks.is_empty() { "none for the QA bundle ends with 0xdead10cc".to_owned() } else { deadlocks.join(", ") }),
    }));
    let date = super::super::checked(Command::new("date").arg("+%Y-%m-%d"))?;
    ensure!(
        sources == super::source_hashes(root)?,
        "Device measurement inputs changed during the run"
    );
    let record = json!({
        "date": String::from_utf8_lossy(&date.stdout).trim(),
        "device": {"model": device.model, "os": device.os, "build": device.build},
        "configuration": CONFIGURATION,
        "source_sha256": super::source_records(&sources),
        "appExecutableSha256": crate::sha256_hex(fs::read(root.join(DERIVED_DATA).join(BUILT_APP).join("PublicPhonebook"))?),
        "appBytes": bytes_under(&root.join(DERIVED_DATA).join(BUILT_APP))?,
        "paths": paths,
        "checks": checks,
    });
    fs::write(root.join(RECORD), serde_json::to_vec_pretty(&record)?)?;
    println!("{}", record_markdown(&record)?);
    println!(
        "Device record written to {RECORD}; add the section to docs/ios-device-verification.md with its conclusions"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_ui_runs_only_the_read_only_case_with_release_qa_identity() -> Result<()> {
        let device = connected_iphone(&report(vec![phone("connected", true, "phone")]), None)?;
        let command = smoke_command(Path::new("/project"), &device);
        let allowance = super::super::SCENARIO_ALLOWANCE_SECONDS.to_string();
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        for pair in [
            ["-configuration", CONFIGURATION],
            ["-scheme", QA_SCHEME],
            ["-destination", "id=phone"],
            ["-xcconfig", LOCAL_SIGNING],
            ["-default-test-execution-time-allowance", &allowance],
            ["-maximum-test-execution-time-allowance", &allowance],
        ] {
            assert!(args.windows(2).any(|window| window == pair));
        }
        assert_eq!(
            args.iter()
                .filter(|arg| arg.starts_with("-only-testing:"))
                .collect::<Vec<_>>(),
            [&format!(
                "-only-testing:PhonebookUITests/DirectoryUITests/{}",
                super::super::LIVE_UI_TEST
            )]
        );
        assert_eq!(
            args.last().map(String::as_str),
            Some("test-without-building")
        );
        assert!(
            !args
                .iter()
                .any(|arg| arg.contains("uninstall") || arg.contains("erase"))
        );
        let automatic = <crate::Arguments as clap::Parser>::try_parse_from([
            "ios-check",
            "ui-test",
            "--live",
            "--device",
        ])?;
        assert!(matches!(
            automatic.action,
            super::super::Action::UiTest {
                device: Some(None),
                ..
            }
        ));
        for (arguments, valid) in [
            (vec!["ios-check", "ui-test", "--live", "--device"], true),
            (
                vec!["ios-check", "ui-test", "--live", "--device", "phone"],
                true,
            ),
            (vec!["ios-check", "ui-test", "--device", "phone"], false),
            (
                vec![
                    "ios-check",
                    "ui-test",
                    "--live",
                    "--device",
                    "phone",
                    "--test",
                    "testSearch",
                ],
                false,
            ),
        ] {
            assert_eq!(
                <crate::Arguments as clap::Parser>::try_parse_from(arguments).is_ok(),
                valid
            );
        }
        Ok(())
    }

    #[test]
    fn qa_installation_builds_the_verification_release_with_local_signing() -> Result<()> {
        let device = connected_iphone(&report(vec![phone("connected", true, "phone")]), None)?;
        let command = qa_build(Path::new("/project"), &device);
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        for pair in [
            ["-scheme", QA_SCHEME],
            ["-configuration", CONFIGURATION],
            ["-xcconfig", LOCAL_SIGNING],
            ["-destination", "id=phone"],
        ] {
            assert!(args.windows(2).any(|window| window == pair));
        }
        assert_eq!(args.last().map(String::as_str), Some("build"));
        assert!(
            !args
                .iter()
                .any(|value| value == "test" || value == "archive" || value == "-exportArchive")
        );
        let root = tempfile::tempdir()?;
        assert!(
            prepare_qa(root.path(), None)
                .is_err_and(|error| error.to_string().contains(LOCAL_SIGNING))
        );
        Ok(())
    }

    #[test]
    fn qa_installation_requires_the_device_to_report_exactly_the_qa_bundle() -> Result<()> {
        let valid = json!({"info":{"outcome":"success"},"result":{"apps":[{"bundleIdentifier":BUNDLE_IDENTIFIER}]}});
        installed_qa(&valid)?;
        for bad in [
            json!({}),
            json!({"info":{"outcome":"success"},"result":{"apps":[]}}),
            json!({"info":{"outcome":"success"},"result":{"apps":[{"bundleIdentifier":"page.dial.publicphonebook"}]}}),
        ] {
            assert!(installed_qa(&bad).is_err());
        }
        Ok(())
    }

    fn phone(state: &str, developer: bool, udid: &str) -> Value {
        json!({
            "identifier": format!("core-{udid}"),
            "properties": {
                "connection": {"state": state, "pairingState": "paired"},
                "hardware": {"reality": "physical", "platform": "iOS", "deviceType": "iPhone", "marketingName": "iPhone Test", "udid": udid},
                "software": {"osVersionNumber": {"stringValue": "27.2"}, "osBuildVersions": {"buildVersion": {"name": "24B119"}}},
                "state": if developer { json!({"developerModeStatus": {"enabled": {"mode": 1}}}) } else { json!({"developerModeStatus": {"disabled": {}}}) },
            }
        })
    }

    fn simulator() -> Value {
        json!({"identifier": "sim", "properties": {"connection": {"state": "connected"}, "hardware": {"reality": "simulated", "platform": "iOS", "deviceType": "iPhone", "udid": "sim"}, "state": {}}})
    }

    fn report(devices: Vec<Value>) -> Value {
        json!({"result": {"devices": devices}})
    }

    #[test]
    fn a_device_record_refuses_unless_one_ready_iphone_is_connected() -> Result<()> {
        let cases = [
            (vec![], None, "No iPhone is connected"),
            (vec![simulator()], None, "No iPhone is connected"),
            (
                vec![phone("disconnected", true, "a")],
                None,
                "is paired but disconnected after a request to open its connection",
            ),
            (
                vec![phone("", true, "a")],
                None,
                "is paired but unavailable after a request to open its connection",
            ),
            (
                vec![phone("connected", false, "a")],
                None,
                "has Developer Mode off",
            ),
            (
                vec![phone("connected", true, "a"), phone("connected", true, "b")],
                None,
                "2 iPhones are connected",
            ),
            (
                vec![phone("connected", true, "a")],
                Some("c"),
                "No paired iPhone has the identifier c",
            ),
        ];
        for (devices, requested, refusal) in cases {
            let error = connected_iphone(&report(devices), requested)
                .err()
                .context("A device record accepted an unready destination")?;
            assert!(error.to_string().contains(refusal), "{error}");
        }
        assert!(connected_iphone(&json!({}), None).is_err());
        let chosen = connected_iphone(
            &report(vec![
                simulator(),
                phone("connected", true, "a"),
                phone("connected", true, "b"),
            ]),
            Some("b"),
        )?;
        assert_eq!(
            chosen,
            Device {
                identifier: "core-b".to_owned(),
                udid: "b".to_owned(),
                model: "iPhone Test".to_owned(),
                os: "27.2".to_owned(),
                build: "24B119".to_owned(),
            }
        );
        assert_eq!(
            connected_iphone(&report(vec![phone("connected", true, "a")]), None)?.udid,
            "a"
        );
        Ok(())
    }

    #[test]
    fn idle_iphones_name_listed_phones_without_a_connection() {
        let mut idle_simulator = simulator();
        idle_simulator["properties"]["connection"]["state"] = json!("disconnected");
        let mut watch = phone("disconnected", true, "w");
        watch["properties"]["hardware"]["platform"] = json!("watchOS");
        let mut pad = phone("disconnected", true, "p");
        pad["properties"]["hardware"]["deviceType"] = json!("iPad");
        let listed = report(vec![
            idle_simulator,
            watch,
            pad,
            phone("connected", true, "b"),
            phone("disconnected", true, "a"),
            phone("", true, "c"),
        ]);
        assert_eq!(idle_iphones(&listed, None), ["core-a", "core-c"]);
        assert_eq!(idle_iphones(&listed, Some("a")), ["core-a"]);
        assert_eq!(idle_iphones(&listed, Some("core-c")), ["core-c"]);
        assert!(idle_iphones(&listed, Some("b")).is_empty());
        assert!(idle_iphones(&json!({}), None).is_empty());
    }

    #[test]
    fn an_idle_iphone_is_woken_once_and_then_selected() -> Result<()> {
        let mut reports = vec![
            report(vec![phone("connected", true, "a")]),
            report(vec![phone("disconnected", true, "a")]),
        ];
        let mut woken = Vec::new();
        let device = select_from(
            || reports.pop().context("listed too often"),
            |identifier| woken.push(identifier.to_owned()),
            None,
        )?;
        assert_eq!(device.udid, "a");
        assert_eq!(woken, ["core-a"]);
        assert!(reports.is_empty());
        let mut ready = vec![report(vec![phone("connected", true, "b")])];
        let mut untouched = Vec::new();
        let device = select_from(
            || ready.pop().context("listed too often"),
            |identifier| untouched.push(identifier.to_owned()),
            None,
        )?;
        assert_eq!(device.udid, "b");
        assert!(untouched.is_empty() && ready.is_empty());
        Ok(())
    }

    #[test]
    fn a_phone_that_stays_idle_after_its_wake_is_refused() {
        let mut reports = vec![
            report(vec![phone("disconnected", true, "a")]),
            report(vec![phone("disconnected", true, "a")]),
        ];
        let mut woken = Vec::new();
        let refusal = select_from(
            || reports.pop().context("listed too often"),
            |identifier| woken.push(identifier.to_owned()),
            None,
        );
        assert!(refusal.is_err_and(|error| {
            error
                .to_string()
                .contains("after a request to open its connection")
        }));
        assert_eq!(woken, ["core-a"]);
        let mut failing = vec![
            Err(anyhow::anyhow!("devicectl stopped")),
            Ok(report(vec![phone("disconnected", true, "a")])),
        ];
        let stopped = select_from(
            || -> Result<Value> { failing.pop().context("listed too often")? },
            |_| {},
            None,
        );
        assert!(stopped.is_err_and(|error| error.to_string().contains("devicectl stopped")));
    }

    const BUNDLED: &str = "5bd74f209c80bf850edeced4031076ba3924713f6f7f5f3209503276bccc3814";
    const NEWER: &str = "1de66a2ffd6d8d2a7c53fe990c20c3025f43c73c3460de175bddca60f1190e4c";
    const DIGEST: &str = "7163c11b450f76d7623dba75a32e7b85268438d6f54926dd5ed6e3c565e5d756";

    fn delta_entry(base: &str, format: &str) -> Value {
        json!({"format": format, "base": base, "url": format!("/api/datasets/{NEWER}/{DIGEST}/directory-delta-{base}.tsv.br"), "sha256": DIGEST, "bytes": 2303})
    }

    #[test]
    fn the_delta_paths_run_only_with_a_listed_delta_from_the_bundle() -> Result<()> {
        let listing = json!({"snapshot": NEWER});
        let deltas = json!({"snapshot": NEWER, "deltas": [delta_entry(NEWER, DELTA_FORMAT), delta_entry(BUNDLED, "other/1"), delta_entry(BUNDLED, DELTA_FORMAT)]});
        let published = select_delta(&listing, Some(&deltas), BUNDLED)?;
        assert_eq!(
            published,
            DeltaInput::Published(DeltaFile {
                url: format!("/api/datasets/{NEWER}/{DIGEST}/directory-delta-{BUNDLED}.tsv.br"),
                sha256: DIGEST.to_owned(),
                bytes: 2303,
            })
        );
        assert_eq!(
            select_delta(&json!({"snapshot": BUNDLED}), Some(&deltas), BUNDLED)?,
            DeltaInput::Current
        );
        assert_eq!(select_delta(&listing, None, BUNDLED)?, DeltaInput::Unlisted);
        let other = json!({"snapshot": NEWER, "deltas": [delta_entry(NEWER, DELTA_FORMAT)]});
        assert_eq!(
            select_delta(&listing, Some(&other), BUNDLED)?,
            DeltaInput::Unlisted
        );
        for (key, value) in [
            ("url", json!("https://elsewhere.example/delta")),
            ("url", json!("/api/datasets/../secret")),
            ("sha256", json!("ABC")),
            ("bytes", json!(0)),
        ] {
            let mut broken = deltas.clone();
            broken["deltas"][2][key] = value;
            assert!(
                select_delta(&listing, Some(&broken), BUNDLED).is_err(),
                "{key}"
            );
        }
        let foreign = json!({"snapshot": BUNDLED, "deltas": []});
        assert!(select_delta(&listing, Some(&foreign), BUNDLED).is_err());
        assert!(select_delta(&json!({}), None, BUNDLED).is_err());
        for delta in [published, DeltaInput::Current, DeltaInput::Unlisted] {
            let plan = planned_paths(&delta);
            assert_eq!(
                plan.map(|(path, _, _)| path),
                RUN_PATHS.map(|(path, _, _)| path)
            );
            for ((_, _, pending), (_, _, needs_delta)) in plan.iter().zip(RUN_PATHS) {
                assert_eq!(
                    pending.is_none(),
                    !needs_delta || matches!(delta, DeltaInput::Published(_)),
                    "{delta:?}"
                );
            }
        }
        Ok(())
    }

    fn attachment(path: &str) -> Value {
        json!({
            "path": path,
            "metrics": [
                {"identifier": "com.apple.dt.XCTMetric_CPU.instructions_retired", "name": "CPU Instructions Retired", "unit": "kI", "values": [5.0, 1.0, 3.0]},
                {"identifier": "com.apple.dt.XCTMetric_Clock.time.monotonic", "name": "Clock Monotonic Time", "unit": "s", "values": [2.5]},
            ],
            "storeBytes": [123_456, 123_456],
        })
    }

    #[test]
    fn native_metrics_require_the_named_case_units_repetitions_and_each_family() -> Result<()> {
        let attachment = json!({"path":"bundledImport","iterations":3,"storeBytes":[123,123,123],
            "observations":vec![json!({"intervals":[
                {"stage":1,"rows":100,"milliseconds":3.0},
                {"stage":2,"rows":100,"milliseconds":1.0}],"phases":[]});3],
            "space":{"observedPeakWorkingBytes":200,"observedPeakScratchBytes":50,"finalStoreBytes":123,
                "observedPeakWorkingAllocatedBytes":160,"observedPeakScratchAllocatedBytes":40,"finalStoreAllocatedBytes":100,"samples":4}});
        let metrics = [
            ("com.apple.dt.XCTMetric_CPU.instructions_retired", "kI"),
            ("com.apple.dt.XCTMetric_Clock.time.monotonic", "s"),
            ("com.apple.dt.XCTMetric_Memory.physical_peak", "kB"),
            ("com.apple.dt.XCTMetric_Disk.logical_writes", "kB"),
        ].map(|(identifier, unit)| json!({"identifier":identifier,"displayName":identifier,"unitOfMeasurement":unit,"measurements":[1.0,2.0,3.0]}));
        let cases = json!([{"testIdentifier":"DeviceMeasurementTests/testBundledImport()","testRuns":[{"metrics":metrics}]}]);
        let measured = native_measurement(&attachment, &cases)?;
        assert_eq!(measured["iterations"], json!(3));
        assert_eq!(measured["metrics"][0]["median"], json!(2.0));
        assert_eq!(measured["space"], attachment["space"]);
        assert_eq!(measured["observations"], attachment["observations"]);
        for (pointer, value) in [
            ("/0/testIdentifier", json!("OtherTests/testBundledImport()")),
            ("/0/testRuns/0/metrics/0/measurements", json!([1.0])),
            ("/0/testRuns/0/metrics/0/measurements/1", json!("2")),
            ("/0/testRuns/0/metrics/3/unitOfMeasurement", json!("")),
            ("/0/testRuns/0/metrics/3/unitOfMeasurement", json!("bytes")),
            ("/0/testRuns/0/metrics/2/identifier", json!("unknown")),
            (
                "/0/testRuns/0/metrics/3/identifier",
                json!("unrelated.storage"),
            ),
            ("/0/testRuns/0/metrics/0/measurements/1", json!(0.0)),
        ] {
            let mut broken = cases.clone();
            *broken
                .pointer_mut(pointer)
                .context("Native metric test pointer")? = value;
            assert!(
                native_measurement(&attachment, &broken).is_err(),
                "{pointer}"
            );
        }
        let mut duplicate = cases.clone();
        duplicate
            .as_array_mut()
            .context("Native metric list")?
            .push(cases[0].clone());
        assert!(native_measurement(&attachment, &duplicate).is_err());
        for (pointer, value) in [
            ("/space/samples", json!(0)),
            ("/space/observedPeakWorkingBytes", json!(100)),
            ("/space/observedPeakScratchBytes", json!(201)),
            ("/space/finalStoreBytes", json!(0)),
            ("/space/observedPeakWorkingAllocatedBytes", json!(99)),
            ("/space/observedPeakScratchAllocatedBytes", json!(161)),
            ("/space/finalStoreAllocatedBytes", json!(0)),
            ("/space/finalStoreAllocatedBytes", json!(null)),
            ("/observations", json!([])),
            ("/observations/0/intervals/0/milliseconds", json!(-1)),
            ("/observations/0/intervals/0/rows", json!(0)),
            ("/observations/0/intervals/0/stage", json!(0)),
        ] {
            let mut broken = attachment.clone();
            *broken
                .pointer_mut(pointer)
                .context("Observation test pointer")? = value;
            assert!(native_measurement(&broken, &cases).is_err(), "{pointer}");
        }
        assert!(
            native_measurement(
                &json!({"path":"bundledImport","iterations":0,"storeBytes":[123]}),
                &cases
            )
            .is_err()
        );
        Ok(())
    }

    #[test]
    fn device_lock_preflight_refuses_locked_or_unknown_states() {
        assert!(device_unlocked(
            &json!({"result":{"passcodeRequired":false}})
        ));
        for value in [json!(true), json!(null), json!("false"), json!(0)] {
            assert!(!device_unlocked(
                &json!({"result":{"passcodeRequired":value}})
            ));
        }
        assert!(!device_unlocked(&json!({})));
    }

    #[test]
    fn measurements_keep_each_metric_median_and_refuse_incomplete_records() -> Result<()> {
        let row = measurement(&attachment("bundledImport"))?;
        assert_eq!(row["metrics"][0]["median"], json!(3.0));
        assert_eq!(row["metrics"][1]["median"], json!(2.5));
        assert_eq!(median(&[]), None);
        assert_eq!(median(&[5.0, 1.0, 3.0, 2.0]), Some(2.5));
        assert!(measurement(&attachment("elsewhere")).is_err());
        for (pointer, value) in [
            (
                "/metrics/0/identifier",
                json!("com.apple.dt.XCTMetric_CPU.cycles"),
            ),
            ("/metrics/1/values", json!([])),
            ("/metrics/1/values/0", json!("2.5")),
            ("/storeBytes", json!([])),
            ("/storeBytes/0", json!(-1)),
        ] {
            let mut broken = attachment("bundledImport");
            *broken.pointer_mut(pointer).context("Test pointer")? = value;
            assert!(measurement(&broken).is_err(), "{pointer}");
        }
        Ok(())
    }

    #[test]
    fn only_a_qa_bundle_report_with_0xdead10cc_counts() {
        let header =
            format!("{{\"bundleID\":\"{BUNDLE_IDENTIFIER}\",\"app_name\":\"PublicPhonebook\"}}");
        let reports = [
            (
                "hex.ips".to_owned(),
                format!("{header}\n{{\"termination\":{{\"indicator\":\"0xDEAD10CC\"}}}}"),
            ),
            (
                "decimal.ips".to_owned(),
                format!("{header}\n{{\"termination\":{{\"code\":3735883980}}}}"),
            ),
            (
                "other.ips".to_owned(),
                format!("{header}\n{{\"termination\":{{\"code\":9}}}}"),
            ),
            (
                "foreign.ips".to_owned(),
                "{\"bundleID\":\"com.example\"}\n0xdead10cc".to_owned(),
            ),
            ("headerless.ips".to_owned(), "0xdead10cc".to_owned()),
        ];
        assert_eq!(
            deadlock_reports(&reports, BUNDLE_IDENTIFIER),
            ["hex.ips", "decimal.ips"]
        );
        assert!(deadlock_reports(&[], BUNDLE_IDENTIFIER).is_empty());
    }

    #[test]
    fn the_walk_records_each_item_and_keeps_unclear_answers_pending() -> Result<()> {
        let mut answers = String::from("pass\nfirst note\nmaybe\nno\nperhaps\n\n");
        for _ in 2..ON_DEVICE_ITEMS.len() {
            answers.push_str("i\n\n");
        }
        let mut output = Vec::new();
        let checks = walk(&mut answers.as_bytes(), &mut output)?;
        assert_eq!(checks.len(), ON_DEVICE_ITEMS.len());
        assert_eq!(checks[0]["outcome"], "passed");
        assert_eq!(checks[0]["note"], "first note");
        assert_eq!(checks[1]["outcome"], PENDING);
        assert!(
            checks[2..]
                .iter()
                .all(|check| check["outcome"] == "inconclusive")
        );
        assert!(String::from_utf8(output)?.contains("[12/12] signposted intervals"));
        for (answer, expected) in [
            ("F", Some("failed")),
            (" skip ", Some(PENDING)),
            ("x", None),
        ] {
            assert_eq!(outcome(answer), expected);
        }
        Ok(())
    }

    #[test]
    fn the_record_section_names_the_device_each_median_and_each_check() -> Result<()> {
        let record = json!({
            "date": "2026-11-04",
            "device": {"model": "iPhone Test", "os": "27.2", "build": "24B119"},
            "configuration": CONFIGURATION,
            "appBytes": 17_274_257,
            "paths": [measurement(&attachment("bundledImport"))?, {"path": "deltaFromTheBundle", "pending": "no delta"}],
            "checks": [{"item": "read-only search", "outcome": "passed", "note": "a | b"}],
        });
        let section = record_markdown(&record)?;
        for expected in [
            "## Recorded measurement on 2026-11-04",
            "iPhone Test with iOS 27.2, build 24B119, in the `VerificationRelease` configuration.",
            "holds 17,274,257 bytes.",
            "| bundledImport | CPU Instructions Retired | 3 | kI |",
            "| bundledImport | saved store | 123,456 | bytes |",
            "| deltaFromTheBundle | pending | no delta | |",
            "| read-only search | passed | a / b |",
        ] {
            assert!(section.contains(expected), "{expected}\n{section}");
        }
        assert_eq!(number(1_234_567.4), "1,234,567");
        assert_eq!(number(-999.0), "-999");
        assert_eq!(number(2.5), "2.5");
        assert_eq!(number(0.125), "0.125");
        assert!(record_markdown(&json!({})).is_err());
        Ok(())
    }
}
