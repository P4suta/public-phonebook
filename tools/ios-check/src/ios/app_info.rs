//! Keeps the launch screen in every app build and local networking out of the builds that leave the Mac.

use super::logged;
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{path::Path, process::Command};

/// The asset catalog color of the launch screen, which matches the first screen's background.
pub(super) const LAUNCH_COLOR: &str = "LaunchBackground";
/// The app's property list that XcodeGen writes, which the distributed configurations use.
pub(super) const APP_INFO: &str = "Config/App-Info.plist";
/// The same property list with local networking, for the configurations that reach the loopback fixture.
pub(super) const LOCAL_NETWORKING_INFO: &str = "Config/App-Info-LocalNetworking.plist";
pub(super) const EXTENSION_INFO: &str = "Config/CallDirectory-Info.plist";
const LOCAL_NETWORKING: &str = "NSAllowsLocalNetworking";
const TRANSPORT_SECURITY: &str = "NSAppTransportSecurity";
const IPAD_ORIENTATIONS: [&str; 4] = [
    "UIInterfaceOrientationPortrait",
    "UIInterfaceOrientationPortraitUpsideDown",
    "UIInterfaceOrientationLandscapeLeft",
    "UIInterfaceOrientationLandscapeRight",
];

/// TestFlight receives VerificationRelease and the App Store receives Release, and both talk to the production origin alone.
/// The other configurations run the UI scenarios, the store screenshots, or development against `http://127.0.0.1`.
pub(super) fn reaches_fixture(configuration: &str) -> bool {
    !matches!(configuration, "Release" | "VerificationRelease")
}

/// The property list that a target must take in a configuration.
pub(super) fn selected_list(target: &str, configuration: &str) -> Result<&'static str> {
    Ok(match target {
        "PublicPhonebook" if reaches_fixture(configuration) => LOCAL_NETWORKING_INFO,
        "PublicPhonebook" => APP_INFO,
        "CallDirectory" => EXTENSION_INFO,
        _ => bail!("Unexpected native target {target}"),
    })
}

/// Requires the launch screen, and local networking exactly in the configurations that reach the loopback fixture.
pub(super) fn require(info: &Value, configuration: &str) -> Result<()> {
    let orientations = info["UISupportedInterfaceOrientations~ipad"].as_array();
    ensure!(
        orientations.is_some_and(|values| {
            values.len() == IPAD_ORIENTATIONS.len()
                && IPAD_ORIENTATIONS
                    .iter()
                    .all(|expected| values.contains(&json!(expected)))
        }),
        "{configuration}: iPad requires all four interface orientations"
    );
    ensure!(
        info.get("UIRequiresFullScreen")
            .is_none_or(|value| value == &json!(false)),
        "{configuration}: iPad windows must support resizing"
    );
    if let Some(families) = info.get("UIDeviceFamily") {
        ensure!(
            families == &json!([1, 2]),
            "{configuration}: the app must support iPhone and iPad device families"
        );
    }
    ensure!(
        info.pointer("/UILaunchScreen/UIColorName")
            .and_then(Value::as_str)
            == Some(LAUNCH_COLOR),
        "{configuration}: the app declares no launch screen with the {LAUNCH_COLOR} color"
    );
    let transport = info.get(TRANSPORT_SECURITY);
    let local = transport.and_then(|keys| keys.get(LOCAL_NETWORKING)) == Some(&Value::Bool(true));
    match (local, reaches_fixture(configuration)) {
        (true, false) => bail!(
            "{configuration}: the app carries {LOCAL_NETWORKING}, which only the configurations that reach the loopback fixture may carry"
        ),
        (false, true) => bail!(
            "{configuration}: the app lacks {LOCAL_NETWORKING}, which the loopback fixture needs"
        ),
        _ => {}
    }
    ensure!(
        transport.is_none_or(|keys| keys
            .as_object()
            .is_some_and(|keys| keys.keys().all(|key| key == LOCAL_NETWORKING))),
        "{configuration}: the app declares an App Transport Security exception other than {LOCAL_NETWORKING}"
    );
    Ok(())
}

fn read(root: &Path, name: &str, path: &Path) -> Result<Value> {
    let output = logged(
        root,
        name,
        Command::new("plutil")
            .args(["-convert", "json", "-o", "-", "--"])
            .arg(path),
    )?;
    serde_json::from_slice(&output.stdout)
        .with_context(|| format!("Decode the property list {}", path.display()))
}

/// The same property list with local networking turned the other way.
fn flipped(info: &Value) -> Result<Value> {
    let mut flipped = info.clone();
    let keys = flipped
        .as_object_mut()
        .context("The property list is not a dictionary")?;
    if keys.remove(TRANSPORT_SECURITY).is_none() {
        keys.insert(
            TRANSPORT_SECURITY.to_owned(),
            json!({ LOCAL_NETWORKING: true }),
        );
    }
    Ok(flipped)
}

/// Checks one built app, and requires the checker to refuse the same property list without the launch screen or with local networking turned.
pub(super) fn check_built(root: &Path, app: &Path, configuration: &str) -> Result<()> {
    let info = read(
        root,
        &format!("app-info-{configuration}"),
        &app.join("Info.plist"),
    )?;
    require(&info, configuration)?;
    ensure!(
        info.get("UIDeviceFamily").is_some(),
        "{configuration}: the built app names no device families"
    );
    let mut without_launch = info.clone();
    without_launch
        .as_object_mut()
        .context("The property list is not a dictionary")?
        .remove("UILaunchScreen");
    ensure!(
        require(&without_launch, configuration)
            .is_err_and(|error| error.to_string().contains("no launch screen")),
        "{configuration}: the property list check accepted an app without a launch screen"
    );
    ensure!(
        require(&flipped(&info)?, configuration)
            .is_err_and(|error| error.to_string().contains(LOCAL_NETWORKING)),
        "{configuration}: the property list check accepted local networking turned the other way"
    );
    println!(
        "PASS: {configuration} declares its launch screen and {} local networking, and both controls fail",
        if reaches_fixture(configuration) {
            "allows"
        } else {
            "refuses"
        }
    );
    Ok(())
}

/// Writes the local networking property list from the one that XcodeGen wrote, so the two differ in that key alone.
pub(super) fn derive(root: &Path) -> Result<()> {
    let directory = root.join("apps/ios");
    let local = directory.join(LOCAL_NETWORKING_INFO);
    logged(
        root,
        "app-info-local-networking",
        Command::new("plutil")
            .args(["-insert", TRANSPORT_SECURITY, "-json"])
            .arg(json!({ LOCAL_NETWORKING: true }).to_string())
            .arg("-o")
            .arg(&local)
            .arg("--")
            .arg(directory.join(APP_INFO)),
    )?;
    let distributed = read(root, "app-info-distributed", &directory.join(APP_INFO))?;
    let reaching = read(root, "app-info-reaching", &local)?;
    require(&distributed, "Release")?;
    require(&reaching, "Debug")?;
    ensure!(
        flipped(&distributed)? == reaching,
        "{LOCAL_NETWORKING_INFO} differs from {APP_INFO} in more than local networking"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(local: bool) -> Value {
        let mut info = json!({"UILaunchScreen": {"UIColorName": LAUNCH_COLOR}, "CFBundleName": "PublicPhonebook"});
        info["UISupportedInterfaceOrientations~ipad"] = json!([
            "UIInterfaceOrientationPortrait",
            "UIInterfaceOrientationPortraitUpsideDown",
            "UIInterfaceOrientationLandscapeLeft",
            "UIInterfaceOrientationLandscapeRight",
        ]);
        if local {
            info[TRANSPORT_SECURITY] = json!({ LOCAL_NETWORKING: true });
        }
        info
    }

    #[test]
    fn tablet_configuration_rejects_missing_orientations_families_and_full_screen_lock()
    -> Result<()> {
        require(&info(false), "Release")?;
        let mut missing_rotation = info(false);
        missing_rotation["UISupportedInterfaceOrientations~ipad"] =
            json!(["UIInterfaceOrientationPortrait"]);
        let mut locked = info(false);
        locked["UIRequiresFullScreen"] = json!(true);
        for invalid in [missing_rotation, locked] {
            assert!(require(&invalid, "Release").is_err());
        }
        for families in [json!([1]), json!([2]), json!([]), json!([1, 2, 7])] {
            let mut invalid = info(false);
            invalid["UIDeviceFamily"] = families;
            assert!(require(&invalid, "Release").is_err());
        }
        let mut complete = info(false);
        complete["UIDeviceFamily"] = json!([1, 2]);
        require(&complete, "Release")
    }

    #[test]
    fn only_the_distributed_configurations_refuse_local_networking() -> Result<()> {
        for configuration in [
            "Debug",
            "DevRelease",
            "VerificationDebug",
            "ProductionDebug",
        ] {
            require(&info(true), configuration)?;
            assert!(
                require(&info(false), configuration).is_err(),
                "{configuration}"
            );
            assert_eq!(
                selected_list("PublicPhonebook", configuration)?,
                LOCAL_NETWORKING_INFO
            );
        }
        for configuration in ["Release", "VerificationRelease"] {
            require(&info(false), configuration)?;
            let error = require(&info(true), configuration).unwrap_err().to_string();
            assert!(error.contains(LOCAL_NETWORKING), "{error}");
            assert_eq!(selected_list("PublicPhonebook", configuration)?, APP_INFO);
        }
        assert_eq!(selected_list("CallDirectory", "Release")?, EXTENSION_INFO);
        assert!(selected_list("PhonebookUITests", "Release").is_err());
        Ok(())
    }

    #[test]
    fn a_missing_launch_screen_or_another_exception_fails() {
        let mut missing = info(false);
        missing
            .as_object_mut()
            .map(|keys| keys.remove("UILaunchScreen"));
        let error = require(&missing, "Release").unwrap_err().to_string();
        assert!(error.contains("no launch screen"), "{error}");
        let mut other_color = info(false);
        other_color["UILaunchScreen"]["UIColorName"] = json!("AccentColor");
        assert!(require(&other_color, "Release").is_err());
        let mut arbitrary = info(true);
        arbitrary[TRANSPORT_SECURITY]["NSAllowsArbitraryLoads"] = json!(true);
        let error = require(&arbitrary, "Debug").unwrap_err().to_string();
        assert!(error.contains("other than"), "{error}");
    }

    #[test]
    fn flipping_turns_local_networking_both_ways() -> Result<()> {
        assert_eq!(flipped(&info(false))?, info(true));
        assert_eq!(flipped(&info(true))?, info(false));
        Ok(())
    }
}
