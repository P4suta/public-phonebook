use super::{
    Simulator, device_name, logged, require_current_sources, require_named_ui_case, source_hashes,
    source_records, ui_test,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const RUNTIME: &str = "com.apple.CoreSimulator.SimRuntime.watchOS-27-0";
const MODEL: &str = "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-11-46mm";
const TESTS: [&str; 2] = [
    "testSearchStartsWithALabeledEntry",
    "testPairedPhoneDirectorySearchAndSource",
];

fn identifier(devices: &Value, runtime: &str, model: &str, name: &str) -> Result<Option<String>> {
    let matches = devices["devices"][runtime]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|device| device["name"] == name && device["deviceTypeIdentifier"] == model)
        .collect::<Vec<_>>();
    ensure!(matches.len() <= 1, "The owned simulator name is ambiguous");
    matches
        .first()
        .map(|device| {
            let id = device["udid"]
                .as_str()
                .context("The owned simulator has no identifier")?;
            ensure!(
                super::signing::uuid(id),
                "The owned simulator identifier is invalid"
            );
            Ok(id.to_owned())
        })
        .transpose()
}

struct Pair(String);

impl Drop for Pair {
    fn drop(&mut self) {
        match Command::new("xcrun")
            .args(["simctl", "unpair", &self.0])
            .status()
        {
            Ok(status) if status.success() => {}
            result => eprintln!("iOS check: owned Watch pair cleanup failed: {result:?}"),
        }
    }
}

fn devices(root: &Path) -> Result<Value> {
    let output = logged(
        root,
        "watch-devices",
        Command::new("xcrun").args(["simctl", "list", "devices", "available", "--json"]),
    )?;
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn unpair_owned(root: &Path, phone: Option<&str>, watch: &str) -> Result<()> {
    let output = logged(
        root,
        "watch-pairs",
        Command::new("xcrun").args(["simctl", "list", "pairs", "--json"]),
    )?;
    let listing: Value = serde_json::from_slice(&output.stdout)?;
    for (id, pair) in listing["pairs"]
        .as_object()
        .context("The simulator pair listing is malformed")?
    {
        let owns_watch = pair["watch"]["udid"] == watch;
        let owns_phone = phone.is_some_and(|phone| pair["phone"]["udid"] == phone);
        if owns_watch || owns_phone {
            ensure!(
                owns_watch && owns_phone && super::signing::uuid(id),
                "An owned test simulator is paired to another device"
            );
            logged(
                root,
                "watch-unpair",
                Command::new("xcrun").args(["simctl", "unpair", id]),
            )?;
        }
    }
    Ok(())
}

pub(super) fn check(root: &Path) -> Result<PathBuf> {
    let sources = source_hashes(root)?;
    let receipt = root.join("target/ios/watch-receipt.json");
    if receipt.exists() {
        fs::remove_file(&receipt)?;
    }
    let listing = devices(root)?;
    ensure!(
        listing["devices"][RUNTIME].is_array(),
        "Install the watchOS 27.0 simulator with `xcodebuild -downloadPlatform watchOS -buildVersion 27.0 -architectureVariant arm64` before the paired check"
    );
    let name = device_name(root);
    let phone = identifier(&listing, super::RUNTIME, super::DEVICE_TYPE, &name)?;
    let watch_name = format!("{name}-watch");
    let watch = if let Some(id) = identifier(&listing, RUNTIME, MODEL, &watch_name)? {
        id
    } else {
        let output = logged(
            root,
            "watch-create",
            Command::new("xcrun").args(["simctl", "create", &watch_name, MODEL, RUNTIME]),
        )?;
        let id = String::from_utf8(output.stdout)?.trim().to_owned();
        ensure!(
            super::signing::uuid(&id),
            "The created Watch identifier is invalid"
        );
        id
    };
    unpair_owned(root, phone.as_deref(), &watch)?;
    ui_test(
        root,
        &["testContactDetailShowsRegionSourceAndExternalLinkConfirmation".to_owned()],
        false,
    )?;
    let fixture = super::Fixture::start(root, super::Revision::Baseline)?;
    let listing = devices(root)?;
    let phone = Simulator(
        identifier(&listing, super::RUNTIME, super::DEVICE_TYPE, &name)?
            .context("The prepared phone simulator is missing")?,
    );
    let booted = listing["devices"][RUNTIME]
        .as_array()
        .into_iter()
        .flatten()
        .any(|device| device["udid"] == watch && device["state"] == "Booted");
    if booted {
        logged(
            root,
            "watch-shutdown",
            Command::new("xcrun").args(["simctl", "shutdown", &watch]),
        )?;
    }
    logged(
        root,
        "watch-erase",
        Command::new("xcrun").args(["simctl", "erase", &watch]),
    )?;
    let output = logged(
        root,
        "watch-pair",
        Command::new("xcrun").args(["simctl", "pair", &watch, phone.id()]),
    )?;
    let pair = String::from_utf8(output.stdout)?.trim().to_owned();
    ensure!(
        super::signing::uuid(&pair),
        "The new simulator pair identifier is invalid"
    );
    let _pair = Pair(pair);
    let watch = Simulator(watch);
    for (kind, simulator) in [("phone", &phone), ("watch", &watch)] {
        logged(
            root,
            &format!("watch-boot-{kind}"),
            Command::new("xcrun").args(["simctl", "boot", simulator.id()]),
        )?;
        logged(
            root,
            &format!("watch-ready-{kind}"),
            Command::new("xcrun").args(["simctl", "bootstatus", simulator.id(), "-b"]),
        )?;
    }
    let products = root.join(
        "ios/DerivedData/Build/Products/VerificationDebug-iphonesimulator/PublicPhonebook.app",
    );
    let application = products.join("Watch/PhonebookWatch.app");
    ensure!(
        application.join("PhonebookWatch").is_file(),
        "The phone build didn't embed the executable Watch companion"
    );
    logged(
        root,
        "watch-install",
        Command::new("xcrun")
            .args(["simctl", "install", watch.id()])
            .arg(&application),
    )?;
    logged(
        root,
        "watch-launch-phone",
        Command::new("xcrun")
            .env(
                "SIMCTL_CHILD_PHONEBOOK_API_ORIGIN",
                format!("http://localhost:{}", fixture.port),
            )
            .args([
                "simctl",
                "launch",
                phone.id(),
                "page.dial.publicphonebook.devicechecks",
            ]),
    )?;
    let directory = tempfile::Builder::new()
        .prefix("watch-ui-")
        .tempdir_in(root.join("target/ios"))?
        .keep();
    let command = || {
        let mut command = Command::new("xcodebuild");
        command.current_dir(root).args([
            "-quiet",
            "-toolchain",
            "com.apple.dt.toolchain.XcodeDefault",
            "-project",
            "ios/PublicPhonebook.xcodeproj",
            "-scheme",
            "PhonebookWatch",
            "-configuration",
            "VerificationDebug",
            "-destination",
            &format!("platform=watchOS Simulator,id={}", watch.id()),
            "-derivedDataPath",
            "ios/DerivedData",
            "-jobs",
            "2",
            "-parallel-testing-enabled",
            "NO",
            "-collect-test-diagnostics",
            "never",
            "-test-timeouts-enabled",
            "YES",
            "-default-test-execution-time-allowance",
            "600",
            "-maximum-test-execution-time-allowance",
            "600",
            "CODE_SIGN_IDENTITY=-",
            "CODE_SIGN_STYLE=Manual",
            "CODE_SIGNING_ALLOWED=YES",
        ]);
        command
    };
    logged(root, "watch-ui-build", command().arg("build-for-testing"))?;
    for name in TESTS {
        let result = directory.join(format!("{name}.xcresult"));
        logged(
            root,
            name,
            command()
                .args([
                    "test-without-building",
                    &format!("-only-testing:PhonebookWatchUITests/WatchDirectoryUITests/{name}"),
                    "-resultBundlePath",
                ])
                .arg(&result),
        )?;
        let report = |kind: &str| -> Result<Value> {
            let output = logged(
                root,
                &format!("{name}-{kind}"),
                Command::new("xcrun")
                    .args(["xcresulttool", "get", "test-results", kind, "--path"])
                    .arg(&result),
            )?;
            Ok(serde_json::from_slice(&output.stdout)?)
        };
        require_named_ui_case(
            &report("summary")?,
            &report("tests")?,
            "WatchDirectoryUITests",
            name,
        )?;
    }
    require_current_sources(root, &sources)?;
    fs::write(
        receipt,
        serde_json::to_vec_pretty(
            &json!({"result":"passed", "tests":TESTS, "results":directory, "runtime":RUNTIME, "model":MODEL, "source_sha256":source_records(&sources), "transport":"real paired Watch Connectivity; phone fixture prepared by the iOS UI case"}),
        )?,
    )?;
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_watch_selection_rejects_ambiguous_or_invalid_identities() -> Result<()> {
        let id = "12345678-1234-1234-1234-123456789012";
        let device = json!({"name":"owned", "deviceTypeIdentifier":MODEL, "udid":id});
        assert_eq!(
            identifier(
                &json!({"devices":{RUNTIME:[device.clone()]}}),
                RUNTIME,
                MODEL,
                "owned"
            )?,
            Some(id.to_owned())
        );
        assert!(
            identifier(
                &json!({"devices":{RUNTIME:[device.clone(),device]}}),
                RUNTIME,
                MODEL,
                "owned"
            )
            .is_err()
        );
        assert!(identifier(&json!({"devices":{RUNTIME:[{"name":"owned", "deviceTypeIdentifier":MODEL, "udid":"foreign"}]}}), RUNTIME, MODEL, "owned").is_err());
        assert_eq!(
            identifier(&json!({"devices":{RUNTIME:[]}}), RUNTIME, MODEL, "owned")?,
            None
        );
        Ok(())
    }
}
