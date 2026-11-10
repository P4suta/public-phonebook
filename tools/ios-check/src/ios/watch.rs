use super::{
    Simulator, SimulatorModel, device_name, logged, require_current_sources, require_named_ui_case,
    screenshots, simulators, source_hashes, source_records, ui_test,
};
use anyhow::{Result, ensure};
use clap::ValueEnum;
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

#[derive(Clone, Copy)]
enum Purpose {
    Checks,
    Screenshots,
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

fn pairs_for_device(
    name: &str,
    devices: &Value,
    pairs: &Value,
    resetting: &simulators::Record,
) -> Result<Vec<String>> {
    let mut handhelds = Vec::new();
    for model in SimulatorModel::value_variants() {
        handhelds.extend(simulators::owned(
            devices,
            &format!("{name}{}", model.suffix()),
            model.device_type(),
        )?);
    }
    let watches = simulators::owned(devices, &format!("{name}-watch"), MODEL)?;
    simulators::pairs_to_remove(pairs, &handhelds, &watches, resetting)
}

pub(super) fn unpair_owned(
    root: &Path,
    devices: &Value,
    resetting: &simulators::Record,
) -> Result<()> {
    let output = logged(
        root,
        "watch-pairs",
        Command::new("xcrun").args(["simctl", "list", "pairs", "--json"]),
    )?;
    let listing: Value = serde_json::from_slice(&output.stdout)?;
    for id in pairs_for_device(&device_name(root), devices, &listing, resetting)? {
        logged(
            root,
            "watch-unpair",
            Command::new("xcrun").args(["simctl", "unpair", &id]),
        )?;
    }
    Ok(())
}

pub(super) fn check(root: &Path) -> Result<PathBuf> {
    run(root, Purpose::Checks)
}

pub(super) fn capture(root: &Path) -> Result<PathBuf> {
    run(root, Purpose::Screenshots)
}

fn run(root: &Path, purpose: Purpose) -> Result<PathBuf> {
    let sources = source_hashes(root)?;
    let (configuration, phone_id, tests, receipt) = match purpose {
        Purpose::Checks => (
            "VerificationDebug",
            "page.dial.publicphonebook.devicechecks",
            TESTS.as_slice(),
            "target/ios/watch-receipt.json",
        ),
        Purpose::Screenshots => (
            "ProductionDebug",
            "page.dial.publicphonebook",
            [super::SAMPLE_UI_TEST].as_slice(),
            "target/ios/app-store-screenshots-watch.json",
        ),
    };
    let receipt = root.join(receipt);
    if receipt.exists() {
        fs::remove_file(&receipt)?;
    }
    let name = device_name(root);
    let watch_name = format!("{name}-watch");
    match purpose {
        Purpose::Checks => {
            ui_test(
                root,
                &["testContactDetailShowsRegionSourceAndExternalLinkConfirmation".to_owned()],
                false,
            )?;
        }
        Purpose::Screenshots => screenshots::capture(root, SimulatorModel::Iphone17)?,
    }
    let fixture = match purpose {
        Purpose::Checks => super::Fixture::start(root, super::Revision::Baseline)?,
        Purpose::Screenshots => {
            super::Fixture::sample_city(root, &root.join("target/ios/screenshot-sample"))?
        }
    };
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
    let products = root.join(format!(
        "apps/ios/DerivedData/Build/Products/{configuration}-iphonesimulator/PublicPhonebook.app"
    ));
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
            configuration,
            &format!("PHONEBOOK_API_ORIGIN=http://localhost:{}", fixture.port),
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
    let bundle = root.join(match purpose {
        Purpose::Checks => "target/ios/bundled-dataset/fixture",
        Purpose::Screenshots => "target/ios/screenshot-sample",
    });
    logged(
        root,
        "watch-launch-phone",
        Command::new("xcrun")
            .env(
                "SIMCTL_CHILD_PHONEBOOK_API_ORIGIN",
                format!("http://localhost:{}", fixture.port),
            )
            .env(
                "SIMCTL_CHILD_PHONEBOOK_BUNDLED_ARCHIVE",
                bundle.join("directory.tsv.br"),
            )
            .env(
                "SIMCTL_CHILD_PHONEBOOK_BUNDLED_ENTRY",
                bundle.join("directory.json"),
            )
            .args(["simctl", "launch", phone.id(), phone_id]),
    )?;
    let mut images = None;
    for name in tests {
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
        if let Purpose::Screenshots = purpose {
            images = Some(screenshots::watch_images(root, &result, &directory)?);
        }
    }
    require_current_sources(root, &sources)?;
    let record = if let Some(images) = images {
        json!({"format":1, "purpose":"App Store screenshot candidate; no upload", "fixture":"sample-city", "locale":"en_US", "content_language":"ja", "configuration":configuration, "simulator_runtime":watch.runtime(), "phone_runtime":phone.runtime(), "simulator_device":MODEL, "directory":images.directory, "size":images.size, "screenshots":images.files, "source_sha256":source_records(&sources)})
    } else {
        json!({"result":"passed", "tests":tests, "results":directory, "runtime":watch.runtime(), "phone_runtime":phone.runtime(), "model":MODEL, "source_sha256":source_records(&sources), "transport":"real paired Watch Connectivity; phone fixture prepared by the iOS UI case"})
    };
    fs::write(receipt, serde_json::to_vec_pretty(&record)?)?;
    if let Purpose::Screenshots = purpose {
        println!(
            "PASS: Japanese Watch store screenshots at {}",
            directory.join("ja").display()
        );
    }
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PHONE: &str = "12345678-1234-1234-1234-123456789012";
    const DUO: &str = "ABCDEF12-1234-1234-1234-123456789012";
    const IPAD: &str = "EF123456-1234-1234-1234-123456789012";
    const WATCH: &str = "BCDEF123-1234-1234-1234-123456789012";
    const FOREIGN: &str = "CDEF1234-1234-1234-1234-123456789012";
    const PAIR: &str = "DEF12345-1234-1234-1234-123456789012";
    const OTHER_PAIR: &str = "F1234567-1234-1234-1234-123456789012";

    fn devices() -> Value {
        let device = |name: &str, model: &str, id: &str| json!({"name":name,"deviceTypeIdentifier":model,"udid":id,"state":"Shutdown","isAvailable":true});
        json!({"devices":{
            "com.apple.CoreSimulator.SimRuntime.iOS-27-2":[
                device("owned", super::super::DEVICE_TYPE, PHONE),
                device("owned-ipad", SimulatorModel::IpadPro13.device_type(), IPAD)
            ],
            "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4":[
                device("owned-duo", SimulatorModel::IphoneDuo.device_type(), DUO)
            ],
            "com.apple.CoreSimulator.SimRuntime.watchOS-27-2":[
                device("owned-watch", MODEL, WATCH),
                device("another project", MODEL, FOREIGN)
            ]
        }})
    }

    fn duo(devices: &Value) -> Result<simulators::Record> {
        simulators::current(
            devices,
            "owned-duo",
            SimulatorModel::IphoneDuo.device_type(),
        )
    }

    #[test]
    fn recreating_a_duo_rejects_its_foreign_watch_before_any_unpairing() -> Result<()> {
        let devices = devices();
        let pairs = json!({"pairs":{
            PAIR:{"phone":{"udid":PHONE},"watch":{"udid":WATCH}},
            OTHER_PAIR:{"phone":{"udid":DUO},"watch":{"udid":FOREIGN}}
        }});
        assert!(pairs_for_device("owned", &devices, &pairs, &duo(&devices)?).is_err());
        Ok(())
    }

    #[test]
    fn recreating_an_unpaired_duo_preserves_the_base_phone_pair() -> Result<()> {
        let devices = devices();
        let pairs = json!({"pairs":{
            PAIR:{"phone":{"udid":PHONE},"watch":{"udid":WATCH}}
        }});
        assert!(pairs_for_device("owned", &devices, &pairs, &duo(&devices)?)?.is_empty());
        Ok(())
    }

    #[test]
    fn recreating_an_unpaired_ipad_preserves_the_base_phone_pair() -> Result<()> {
        let devices = devices();
        let pairs = json!({"pairs":{
            PAIR:{"phone":{"udid":PHONE},"watch":{"udid":WATCH}}
        }});
        let ipad = simulators::current(
            &devices,
            "owned-ipad",
            SimulatorModel::IpadPro13.device_type(),
        )?;
        assert!(pairs_for_device("owned", &devices, &pairs, &ipad)?.is_empty());
        Ok(())
    }

    #[test]
    fn recreating_the_watch_recognizes_an_owned_duo_peer() -> Result<()> {
        let devices = devices();
        let pairs = json!({"pairs":{
            PAIR:{"phone":{"udid":DUO},"watch":{"udid":WATCH}}
        }});
        let watch = simulators::current(&devices, "owned-watch", MODEL)?;
        assert_eq!(
            pairs_for_device("owned", &devices, &pairs, &watch)?,
            vec![PAIR]
        );
        Ok(())
    }
}
