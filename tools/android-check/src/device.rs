use crate::{completed, file_digest, install, sdk, write_json};
use anyhow::{Context, Result, ensure};
use serde_json::json;
use std::{fs, path::Path, process::Command};

const APPLICATION: &str = "page.dial.publicphonebook.verification";

fn adb(serial: &str) -> Result<Command> {
    ensure!(
        !serial.is_empty()
            && serial
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c)),
        "Invalid device selector"
    );
    let mut command = Command::new(sdk()?.join("platform-tools/adb"));
    command.args(["-s", serial]);
    Ok(command)
}

pub fn check(root: &Path, serial: &str, fresh: bool) -> Result<u32> {
    install(root, serial)?;
    if fresh {
        let mut clear = adb(serial)?;
        clear.args(["shell", "pm", "clear", APPLICATION]);
        ensure!(
            String::from_utf8(completed(clear)?.stdout)?.contains("Success"),
            "Cannot clear the verification app's data"
        );
    }
    let test_apk = root.join("android/app/build/outputs/apk/androidTest/verification/debug/app-verification-debug-androidTest.apk");
    let mut command = adb(serial)?;
    command.args(["install", "-r"]).arg(&test_apk);
    completed(command)?;
    let destination = root
        .join("target/android/devices")
        .join(serial.replace(':', "_"));
    fs::create_dir_all(&destination)?;
    let mut instrument = adb(serial)?;
    instrument.args([
        "shell",
        "am",
        "instrument",
        "-w",
        "-r",
        "page.dial.publicphonebook.verification.test/androidx.test.runner.AndroidJUnitRunner",
    ]);
    let output = completed(instrument)?;
    let log = String::from_utf8(output.stdout)?;
    fs::write(destination.join("instrumentation.txt"), &log)?;
    ensure!(
        log.contains("OK (2 tests)")
            && !log.contains("FAILURES")
            && !log.contains("INSTRUMENTATION_FAILED"),
        "Device tests did not pass; inspect the retained instrumentation record"
    );
    let mut version = adb(serial)?;
    version.args(["shell", "getprop", "ro.build.version.sdk"]);
    let api: u32 = String::from_utf8(completed(version)?.stdout)?
        .trim()
        .parse()?;
    let mut model = adb(serial)?;
    model.args(["shell", "getprop", "ro.product.model"]);
    let model = String::from_utf8(completed(model)?.stdout)?
        .trim()
        .to_owned();
    let mut pull = adb(serial)?;
    pull.args([
        "pull",
        "/sdcard/Android/data/page.dial.publicphonebook.verification/files/screenshots",
    ])
    .arg(&destination);
    completed(pull)?;
    let metric = |key: &str| -> Result<u64> {
        log.lines()
            .find_map(|line| line.strip_prefix(&format!("INSTRUMENTATION_STATUS: {key}=")))
            .context("Missing device metric")?
            .trim()
            .parse()
            .context("Invalid device metric")
    };
    let apk =
        root.join("android/app/build/outputs/apk/verification/debug/app-verification-debug.apk");
    write_json(
        &destination.join("receipt.json"),
        &json!({"sdk":api,"model":model,"apkSha256":file_digest(&apk)?,"testApkSha256":file_digest(&test_apk)?,"freshPreparation":fresh,"tests":2,"preparationMs":metric("preparationMs")?,"searchMs":metric("searchMs")?,"totalPssKiB":metric("totalPssKiB")?,"callerIdentification":"unverified","physicalDevice":!serial.starts_with("emulator-")}),
    )?;
    println!(
        "Android API {api}: 2 device tests passed; metrics and screenshots retained at {}",
        destination.display()
    );
    Ok(api)
}
