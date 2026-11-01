use super::{logged, require_current_sources, source_hashes};
use crate::locations::{FIXTURE_ORIGIN, PRODUCTION_ORIGIN};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path, process::Command};

const STORE_TEXT_LIMITS: [(&str, usize); 6] = [
    ("name", 30),
    ("subtitle", 30),
    ("promotionalText", 170),
    ("description", 4000),
    ("keywords", 100),
    ("reviewNotes", 4000),
];
const EXPORT_OPTIONS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>method</key><string>app-store-connect</string><key>destination</key><string>export</string><key>signingStyle</key><string>automatic</string><key>manageAppVersionAndBuildNumber</key><false/><key>uploadSymbols</key><true/></dict></plist>";

#[derive(Clone, Copy)]
enum Environment {
    Development,
    Verification,
    Production,
}

impl Environment {
    fn identity(self) -> (&'static str, &'static str, &'static str, &'static str) {
        match self {
            Self::Development => (
                "page.dial.publicphonebook.development",
                "Public Phonebook DEV",
                "AppIconDevelopment",
                FIXTURE_ORIGIN,
            ),
            Self::Verification => (
                "page.dial.publicphonebook.devicechecks",
                "Public Phonebook QA",
                "AppIconVerification",
                PRODUCTION_ORIGIN,
            ),
            Self::Production => (
                "page.dial.publicphonebook",
                "Public Phonebook",
                "AppIcon",
                PRODUCTION_ORIGIN,
            ),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetSettings {
    target: String,
    build_settings: BTreeMap<String, Value>,
}

fn validate(settings: &TargetSettings, environment: Environment, debug: bool) -> Result<()> {
    let (bundle, name, icon, origin) = environment.identity();
    let expected = [
        ("PHONEBOOK_BUNDLE_ID", bundle.to_owned()),
        ("PHONEBOOK_DISPLAY_NAME", name.to_owned()),
        ("PHONEBOOK_API_ORIGIN", origin.to_owned()),
        ("PHONEBOOK_APP_GROUP", format!("group.{bundle}")),
        (
            "PHONEBOOK_CALL_DIRECTORY",
            format!("{bundle}.CallDirectory"),
        ),
        ("ASSETCATALOG_COMPILER_APPICON_NAME", icon.to_owned()),
        ("MARKETING_VERSION", "1.0".to_owned()),
        ("IPHONEOS_DEPLOYMENT_TARGET", "18.0".to_owned()),
    ];
    for (key, value) in expected {
        ensure!(
            settings.build_settings.get(key).and_then(Value::as_str) == Some(value.as_str()),
            "{}: invalid {key}",
            settings.target
        );
    }
    let expected_bundle = match settings.target.as_str() {
        "PublicPhonebook" => bundle.to_owned(),
        "CallDirectory" => format!("{bundle}.CallDirectory"),
        _ => anyhow::bail!("Unexpected native target"),
    };
    ensure!(
        settings
            .build_settings
            .get("PRODUCT_BUNDLE_IDENTIFIER")
            .and_then(Value::as_str)
            == Some(expected_bundle.as_str()),
        "Incorrect target identity"
    );
    let conditions = settings
        .build_settings
        .get("SWIFT_ACTIVE_COMPILATION_CONDITIONS")
        .and_then(Value::as_str)
        .unwrap_or("");
    ensure!(
        conditions.split_whitespace().any(|value| value == "DEBUG") == debug,
        "Incorrect optimization environment"
    );
    Ok(())
}

pub(super) fn configurations(root: &Path) -> Result<()> {
    let metadata: Value =
        serde_json::from_slice(&fs::read(root.join("ios/AppStore/metadata.json"))?)?;
    ensure!(
        metadata["name"] == Environment::Production.identity().1
            && metadata["primaryLocale"] == "ja"
            && metadata["bundleId"] == Environment::Production.identity().0
            && metadata["version"] == "1.0"
            && metadata["releaseType"] == "MANUAL"
            && metadata["signInRequired"] == false,
        "Incorrect App Store identity or release policy"
    );
    for (field, maximum) in STORE_TEXT_LIMITS {
        let value = metadata[field].as_str().context("Missing store text")?;
        ensure!(
            !value.is_empty() && value.chars().count() <= maximum,
            "Invalid App Store text: {field}"
        );
    }
    for (config, environment, debug) in [
        ("Debug", Environment::Development, true),
        ("DevelopmentRelease", Environment::Development, false),
        ("VerificationDebug", Environment::Verification, true),
        ("VerificationRelease", Environment::Verification, false),
        ("ProductionDebug", Environment::Production, true),
        ("Release", Environment::Production, false),
    ] {
        let output = logged(
            root,
            &format!("configuration-{config}"),
            Command::new("xcodebuild").current_dir(root).args([
                "-quiet",
                "-toolchain",
                "com.apple.dt.toolchain.XcodeDefault",
                "-project",
                "ios/PublicPhonebook.xcodeproj",
                "-alltargets",
                "-configuration",
                config,
                "-destination",
                "generic/platform=iOS",
                "-showBuildSettings",
                "-json",
            ]),
        )?;
        let mut targets: Vec<TargetSettings> = serde_json::from_slice(&output.stdout)?;
        targets.retain(|target| {
            ["PublicPhonebook", "CallDirectory"].contains(&target.target.as_str())
        });
        ensure!(
            targets
                .iter()
                .map(|target| target.target.as_str())
                .collect::<std::collections::BTreeSet<_>>()
                == ["PublicPhonebook", "CallDirectory"].into_iter().collect(),
            "Configuration omitted an app or extension"
        );
        let mut visited = std::collections::BTreeSet::new();
        for mut target in targets {
            validate(&target, environment, debug)?;
            if !visited.insert(target.target.clone()) {
                continue;
            }
            for key in [
                "PHONEBOOK_BUNDLE_ID",
                "PHONEBOOK_API_ORIGIN",
                "PHONEBOOK_APP_GROUP",
                "PHONEBOOK_CALL_DIRECTORY",
                "ASSETCATALOG_COMPILER_APPICON_NAME",
                "PRODUCT_BUNDLE_IDENTIFIER",
            ] {
                let previous = target
                    .build_settings
                    .insert(key.to_owned(), json!("incorrect-environment"));
                ensure!(
                    validate(&target, environment, debug).is_err(),
                    "Configuration negative control was accepted: {key}"
                );
                target.build_settings.remove(key);
                ensure!(
                    validate(&target, environment, debug).is_err(),
                    "Missing configuration field was accepted: {key}"
                );
                match previous {
                    Some(value) => {
                        target.build_settings.insert(key.to_owned(), value);
                    }
                    None => {
                        target.build_settings.remove(key);
                    }
                }
            }
        }
    }
    println!(
        "PASS: all six build configurations, both native targets each, and 144 rejected environment defects"
    );
    Ok(())
}

fn plist(root: &Path, path: &Path) -> Result<Value> {
    let output = logged(
        root,
        "distribution-plist",
        Command::new("plutil")
            .args(["-convert", "json", "-o", "-", "--"])
            .arg(path),
    )?;
    serde_json::from_slice(&output.stdout).context("Decode distribution property list")
}

fn verify_bundle(root: &Path, app: &Path, team: &str) -> Result<()> {
    let (bundle, name, icon, origin) = Environment::Production.identity();
    for (relative, suffix) in [("", ""), ("PlugIns/CallDirectory.appex", ".CallDirectory")] {
        let directory = app.join(relative);
        let info = plist(root, &directory.join("Info.plist"))?;
        ensure!(
            info["CFBundleDevelopmentRegion"] == "ja"
                && info["CFBundleLocalizations"] == json!(["ja"]),
            "Missing Japanese app localization"
        );
        ensure!(
            info["CFBundleIdentifier"] == format!("{bundle}{suffix}")
                && info["CFBundleDisplayName"] == name,
            "Non-production app identity"
        );
        ensure!(
            info["PhonebookAPIOrigin"] == origin
                && info["PhonebookAppGroup"] == format!("group.{bundle}")
                && info["PhonebookCallDirectory"] == format!("{bundle}.CallDirectory"),
            "Non-production service or extension configuration"
        );
        ensure!(
            info["CFBundleShortVersionString"] == "1.0" && info["MinimumOSVersion"] == "18.0",
            "Incorrect app version or deployment target"
        );
        ensure!(
            info["ITSAppUsesNonExemptEncryption"] == false,
            "Missing encryption declaration"
        );
        let privacy = plist(root, &directory.join("PrivacyInfo.xcprivacy"))?;
        ensure!(
            privacy["NSPrivacyTracking"] == false
                && privacy["NSPrivacyCollectedDataTypes"] == json!([]),
            "Unexpected privacy manifest"
        );
        logged(
            root,
            "distribution-signature",
            Command::new("codesign")
                .args(["--verify", "--strict", "--verbose=2"])
                .arg(&directory),
        )?;
        let identity = logged(
            root,
            "distribution-identity",
            Command::new("codesign")
                .args(["-d", "--verbose=2"])
                .arg(&directory),
        )?;
        let identity = String::from_utf8(identity.stderr)?;
        ensure!(
            identity
                .lines()
                .any(|line| line.starts_with("Authority=Apple Distribution:")),
            "Export is not signed for Apple distribution"
        );
        let entitlement_path = app
            .parent()
            .context("Missing export parent")?
            .join(format!("entitlements{suffix}.plist"));
        logged(
            root,
            "distribution-entitlements",
            Command::new("codesign")
                .args(["-d", "--entitlements"])
                .arg(&entitlement_path)
                .arg("--xml")
                .arg(&directory),
        )?;
        let entitlements = plist(root, &entitlement_path)?;
        ensure!(
            entitlements["application-identifier"] == format!("{team}.{bundle}{suffix}")
                && entitlements["com.apple.developer.team-identifier"] == team,
            "Unexpected signing identity"
        );
        ensure!(
            entitlements["get-task-allow"] == false
                && entitlements["com.apple.security.application-groups"]
                    == json!([format!("group.{bundle}")]),
            "Invalid distribution entitlements"
        );
        if suffix.is_empty() {
            ensure!(
                info["CFBundleIcons"]["CFBundlePrimaryIcon"]["CFBundleIconName"] == icon,
                "Development or QA icon in distribution"
            );
            ensure!(
                info["PhonebookBackgroundRefresh"] == format!("{bundle}.refresh")
                    && info["BGTaskSchedulerPermittedIdentifiers"]
                        == json!([format!("{bundle}.refresh")]),
                "Incorrect background task registration"
            );
            ensure!(
                fs::read(directory.join("Lucide.txt"))?
                    == fs::read(root.join("design/licenses/Lucide.txt"))?,
                "Missing or altered third-party notices"
            );
        }
    }
    Ok(())
}

pub(super) fn archive(root: &Path) -> Result<()> {
    let sources = source_hashes(root)?;
    let directory = tempfile::Builder::new()
        .prefix("app-store-")
        .tempdir_in(root.join("target/ios"))?
        .keep();
    let archive = directory.join("PublicPhonebook.xcarchive");
    logged(
        root,
        "app-store-archive",
        Command::new("xcodebuild")
            .current_dir(root)
            .args([
                "-quiet",
                "-toolchain",
                "com.apple.dt.toolchain.XcodeDefault",
                "-project",
                "ios/PublicPhonebook.xcodeproj",
                "-scheme",
                "PublicPhonebook",
                "-configuration",
                "Release",
                "-destination",
                "generic/platform=iOS",
                "-jobs",
                "2",
                "-allowProvisioningUpdates",
                "-archivePath",
            ])
            .arg(&archive)
            .arg("-derivedDataPath")
            .arg(directory.join("DerivedData"))
            .arg("archive"),
    )?;
    let team = super::plist_string(&archive.join("Info.plist"), "ApplicationProperties.Team")?;
    let options = directory.join("ExportOptions.plist");
    fs::write(&options, EXPORT_OPTIONS)?;
    let exported = directory.join("export");
    logged(
        root,
        "app-store-export",
        Command::new("xcodebuild")
            .current_dir(root)
            .args([
                "-quiet",
                "-exportArchive",
                "-allowProvisioningUpdates",
                "-archivePath",
            ])
            .arg(&archive)
            .arg("-exportOptionsPlist")
            .arg(&options)
            .arg("-exportPath")
            .arg(&exported),
    )?;
    let packages = fs::read_dir(&exported)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .filter(|path| path.extension().is_some_and(|extension| extension == "ipa"))
        .collect::<Vec<_>>();
    ensure!(packages.len() == 1, "Export must contain exactly one IPA");
    let ipa = &packages[0];
    let unpacked = directory.join("inspection");
    logged(
        root,
        "app-store-unpack",
        Command::new("ditto")
            .args(["-x", "-k"])
            .arg(ipa)
            .arg(&unpacked),
    )?;
    verify_bundle(root, &unpacked.join("Payload/PublicPhonebook.app"), &team)?;
    require_current_sources(root, &sources)?;
    let revision = super::super::checked(
        Command::new("git")
            .current_dir(root)
            .args(["rev-parse", "HEAD"]),
    )?;
    let status = super::super::checked(
        Command::new("git")
            .current_dir(root)
            .args(["status", "--porcelain"]),
    )?;
    let sha256 = format!("{:x}", Sha256::digest(fs::read(ipa)?));
    let sbom = json!({"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"metadata":{"component":{"type":"application","name":Environment::Production.identity().1,"version":"1.0","hashes":[{"alg":"SHA-256","content":sha256}]}},"components":[{"type":"library","name":"PhonebookCore","version":"1.0","licenses":[{"expression":"MIT OR Apache-2.0"}],"scope":"required"},{"type":"library","name":"PhonebookKit","version":"1.0","licenses":[{"expression":"MIT OR Apache-2.0"}],"scope":"required"},{"type":"data","name":"Lucide icons","licenses":[{"license":{"id":"ISC"}}],"scope":"required"},{"type":"data","name":"Feather-derived icons","licenses":[{"license":{"id":"MIT"}}],"scope":"required"}],"properties":[{"name":"phonebook:platform-dependencies","value":"Apple iOS frameworks, Swift runtime, and SQLite are supplied by iOS; no third-party Swift packages are linked."}]});
    fs::write(
        directory.join("sbom.cdx.json"),
        serde_json::to_vec_pretty(&sbom)?,
    )?;
    let manifest = json!({"format":1,"purpose":"private App Store preparation; no upload or submission","source_revision":String::from_utf8(revision.stdout)?.trim(),"working_tree_dirty":!status.stdout.is_empty(),"source_sha256":sources,"version":"1.0","build":"1","bundle":"page.dial.publicphonebook","archive":archive,"artifact":ipa,"sha256":sha256,"signature":"verified with production identities, app group, and get-task-allow=false for the app and its extension","release_eligible":false,"pending":["clean owner-approved source revision","current full candidate assurance","public production API and privacy URL verification","store screenshots and final declarations","owner authorization for upload, submission, and publication"]});
    fs::write(
        directory.join("candidate.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    fs::write(
        root.join("target/ios/app-store-candidate.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    println!(
        "PASS: private App Store archive and IPA; production identity, signature, extensions, notices, privacy manifests, SBOM, and SHA-256 checked at {}",
        directory.display()
    );
    Ok(())
}
