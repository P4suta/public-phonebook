use super::{
    Simulator, device_name, logged, require_current_sources, require_named_ui_case, simulators,
    source_hashes, source_records, ui_test,
};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const MODEL: &str = "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-11-46mm";
const TESTS: [&str; 2] = [
    "testSearchStartsWithALabeledEntry",
    "testPairedPhoneDirectorySearchAndSource",
];

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

pub(super) fn unpair_owned(root: &Path, devices: &Value) -> Result<()> {
    let name = device_name(root);
    let phones = simulators::owned(devices, &name, super::DEVICE_TYPE)?;
    let watches = simulators::owned(devices, &format!("{name}-watch"), MODEL)?;
    let output = logged(
        root,
        "watch-pairs",
        Command::new("xcrun").args(["simctl", "list", "pairs", "--json"]),
    )?;
    let listing: Value = serde_json::from_slice(&output.stdout)?;
    for id in simulators::pairs_to_remove(&listing, &phones, &watches)? {
        logged(
            root,
            "watch-unpair",
            Command::new("xcrun").args(["simctl", "unpair", &id]),
        )?;
    }
    Ok(())
}

pub(super) fn check(root: &Path) -> Result<PathBuf> {
    let sources = source_hashes(root)?;
    let receipt = root.join("target/ios/watch-receipt.json");
    if receipt.exists() {
        fs::remove_file(&receipt)?;
    }
    let name = device_name(root);
    let watch_name = format!("{name}-watch");
    ui_test(
        root,
        &["testContactDetailShowsRegionSourceAndExternalLinkConfirmation".to_owned()],
        false,
    )?;
    let fixture = super::Fixture::start(root, super::Revision::Baseline)?;
    let phone = Simulator(simulators::current(
        &simulators::list(root)?,
        &name,
        super::DEVICE_TYPE,
    )?);
    let watch = Simulator(simulators::create(root, &watch_name, MODEL)?);
    let output = logged(
        root,
        "watch-pair",
        Command::new("xcrun").args(["simctl", "pair", watch.id(), phone.id()]),
    )?;
    let pair = String::from_utf8(output.stdout)?.trim().to_owned();
    ensure!(
        super::signing::uuid(&pair),
        "The new simulator pair identifier is invalid"
    );
    let _pair = Pair(pair);
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
        "apps/ios/DerivedData/Build/Products/VerificationDebug-iphonesimulator/PublicPhonebook.app",
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
            "apps/ios/PublicPhonebook.xcodeproj",
            "-scheme",
            "PhonebookWatch",
            "-configuration",
            "VerificationDebug",
            "-destination",
            &format!("platform=watchOS Simulator,id={}", watch.id()),
            "-derivedDataPath",
            "apps/ios/DerivedData",
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
            &json!({"result":"passed", "tests":TESTS, "results":directory, "runtime":watch.runtime(), "phone_runtime":phone.runtime(), "model":MODEL, "source_sha256":source_records(&sources), "transport":"real paired Watch Connectivity; phone fixture prepared by the iOS UI case"}),
        )?,
    )?;
    Ok(directory)
}
