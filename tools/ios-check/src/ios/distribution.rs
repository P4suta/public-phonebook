use super::{
    build_number::BuildNumber,
    logged, receipts, require_current_sources,
    signing::{self, EXTENSION_SUFFIX, ManualSigning, Signing},
    source_hashes,
};
use crate::locations::{FIXTURE_ORIGIN, PRODUCTION_ORIGIN};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::Path, process::Command};

const STORE_TEXT_LIMITS: [(&str, usize); 6] = [
    ("name", 30),
    ("subtitle", 30),
    ("promotionalText", 170),
    ("description", 4000),
    ("keywords", 100),
    ("reviewNotes", 4000),
];

/// Swift Build compiles every Swift package with its Debug configuration when the project configuration's name contains one of these words in any case.
/// `packageConfigurationOverride` in swift-build's `BuildParameters.swift` holds that rule.
const PACKAGE_DEBUG_WORDS: [&str; 2] = ["debug", "development"];

/// Whether Swift Build compiles the Swift packages of configuration `name` with their Debug configuration.
fn packages_build_debug(name: &str) -> bool {
    let name = name.to_lowercase();
    PACKAGE_DEBUG_WORDS.iter().any(|word| name.contains(word))
}

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

fn validate(
    settings: &TargetSettings,
    config: &str,
    environment: Environment,
    debug: bool,
) -> Result<()> {
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
        (
            "PHONEBOOK_BUNDLED_DATASET",
            super::bundled::Dataset::of(config).name().to_owned(),
        ),
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
    let list = super::app_info::selected_list(&settings.target, config)?;
    ensure!(
        settings
            .build_settings
            .get("INFOPLIST_FILE")
            .and_then(Value::as_str)
            == Some(list),
        "{}: {config} must take its property list from {list}",
        settings.target
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
    ensure!(
        conditions
            .split_whitespace()
            .any(|value| value == super::store_build::CONDITION)
            == matches!(environment, Environment::Verification),
        "{}: {} must appear in the verification configurations and nowhere else",
        settings.target,
        super::store_build::CONDITION
    );
    Ok(())
}

/// Adds the verification tools condition where it is absent and removes it where it is present.
fn flip_verification_tools(settings: &TargetSettings) -> TargetSettings {
    let conditions = settings
        .build_settings
        .get("SWIFT_ACTIVE_COMPILATION_CONDITIONS")
        .and_then(Value::as_str)
        .unwrap_or("");
    let present = conditions
        .split_whitespace()
        .any(|value| value == super::store_build::CONDITION);
    let flipped = if present {
        conditions
            .split_whitespace()
            .filter(|value| *value != super::store_build::CONDITION)
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        format!("{conditions} {}", super::store_build::CONDITION)
    };
    let mut build_settings = settings.build_settings.clone();
    build_settings.insert(
        "SWIFT_ACTIVE_COMPILATION_CONDITIONS".to_owned(),
        json!(flipped),
    );
    TargetSettings {
        target: settings.target.clone(),
        build_settings,
    }
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
    let configurations = [
        ("Debug", Environment::Development, true),
        ("DevRelease", Environment::Development, false),
        ("VerificationDebug", Environment::Verification, true),
        ("VerificationRelease", Environment::Verification, false),
        ("ProductionDebug", Environment::Production, true),
        ("Release", Environment::Production, false),
    ];
    for (config, _, debug) in &configurations {
        ensure!(
            packages_build_debug(config) == *debug,
            "{config}: Swift Build would compile its Swift packages with their {} configuration",
            if *debug { "Release" } else { "Debug" }
        );
    }
    // The six reads don't depend on each other, so they run at once; validation keeps the table order.
    let outputs = std::thread::scope(|scope| {
        let readers = configurations
            .iter()
            .map(|(config, _, _)| {
                scope.spawn(move || {
                    logged(
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
                    )
                })
            })
            .collect::<Vec<_>>();
        readers
            .into_iter()
            .map(|reader| {
                reader
                    .join()
                    .map_err(|_| anyhow::anyhow!("A build settings reader panicked"))?
            })
            .collect::<Vec<_>>()
    });
    for ((config, environment, debug), output) in configurations.into_iter().zip(outputs) {
        let output = output?;
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
            validate(&target, config, environment, debug)?;
            if !visited.insert(target.target.clone()) {
                continue;
            }
            ensure!(
                validate(
                    &flip_verification_tools(&target),
                    config,
                    environment,
                    debug
                )
                .is_err(),
                "Configuration negative control was accepted: {}",
                super::store_build::CONDITION
            );
            for key in [
                "PHONEBOOK_BUNDLE_ID",
                "PHONEBOOK_API_ORIGIN",
                "PHONEBOOK_BUNDLED_DATASET",
                "PHONEBOOK_APP_GROUP",
                "PHONEBOOK_CALL_DIRECTORY",
                "ASSETCATALOG_COMPILER_APPICON_NAME",
                "PRODUCT_BUNDLE_IDENTIFIER",
                "INFOPLIST_FILE",
            ] {
                let previous = target
                    .build_settings
                    .insert(key.to_owned(), json!("incorrect-environment"));
                ensure!(
                    validate(&target, config, environment, debug).is_err(),
                    "Configuration negative control was accepted: {key}"
                );
                target.build_settings.remove(key);
                ensure!(
                    validate(&target, config, environment, debug).is_err(),
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
        "PASS: all six build configurations, both native targets each, and 204 rejected environment defects"
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

fn verify_bundle(root: &Path, app: &Path, team: &str, build: BuildNumber) -> Result<()> {
    let (bundle, name, icon, origin) = Environment::Production.identity();
    for (relative, suffix) in [("", ""), ("PlugIns/CallDirectory.appex", EXTENSION_SUFFIX)] {
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
            info["CFBundleVersion"] == build.to_string(),
            "The export doesn't carry build number {build}"
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
                    && info["PhonebookBackgroundCheck"] == format!("{bundle}.check")
                    && info["UIBackgroundModes"] == json!(["fetch", "processing"])
                    && info["BGTaskSchedulerPermittedIdentifiers"]
                        == json!([format!("{bundle}.refresh"), format!("{bundle}.check")]),
                "Incorrect background task registration"
            );
            ensure!(
                fs::read(directory.join("Lucide.txt"))?
                    == fs::read(root.join("design/licenses/Lucide.txt"))?,
                "Missing or altered third-party notices"
            );
            super::bundled::check_built(root, &directory, "Release")?;
        }
    }
    Ok(())
}

pub(super) struct ArchiveRequest {
    pub signing: Signing,
    pub require_receipts: bool,
    pub build: Option<BuildNumber>,
}

fn archive_command(
    root: &Path,
    directory: &Path,
    manual: Option<&ManualSigning>,
    build: BuildNumber,
) -> Command {
    let mut command = Command::new("xcodebuild");
    command.current_dir(root).args([
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
    ]);
    if manual.is_none() {
        command.arg("-allowProvisioningUpdates");
    }
    command
        .arg("-archivePath")
        .arg(directory.join("PublicPhonebook.xcarchive"))
        .arg("-derivedDataPath")
        .arg(directory.join("DerivedData"))
        .args(signing::archive_settings(manual, build))
        .arg("archive");
    command
}

fn export_command(directory: &Path, root: &Path, manual: Option<&ManualSigning>) -> Command {
    let mut command = Command::new("xcodebuild");
    command.current_dir(root).args(["-quiet", "-exportArchive"]);
    if manual.is_none() {
        command.arg("-allowProvisioningUpdates");
    }
    command
        .arg("-archivePath")
        .arg(directory.join("PublicPhonebook.xcarchive"))
        .arg("-exportOptionsPlist")
        .arg(directory.join("ExportOptions.plist"))
        .arg("-exportPath")
        .arg(directory.join("export"));
    command
}

pub(super) fn archive(root: &Path, request: &ArchiveRequest) -> Result<()> {
    let build = signing::admit_request(request.signing, request.require_receipts, request.build)?;
    let ci = request.signing == Signing::Ci;
    let sources = source_hashes(root)?;
    let status = super::super::checked(
        Command::new("git")
            .current_dir(root)
            .args(["status", "--porcelain"]),
    )?;
    let dirty = !status.stdout.is_empty();
    ensure!(
        !(ci && dirty),
        "CI signing requires a clean checkout of the verified revision"
    );
    let receipts = if request.require_receipts {
        receipts::require(root, &sources)?
    } else {
        Vec::new()
    };
    let bundle = Environment::Production.identity().0;
    let ci_signing = if ci {
        Some(signing::prepare(bundle)?)
    } else {
        None
    };
    let manual: Option<&ManualSigning> = ci_signing.as_ref().map(|prepared| &prepared.manual);
    let directory = tempfile::Builder::new()
        .prefix("app-store-")
        .tempdir_in(root.join("target/ios"))?
        .keep();
    let archive = directory.join("PublicPhonebook.xcarchive");
    logged(
        root,
        "app-store-archive",
        &mut archive_command(root, &directory, manual, build),
    )?;
    let team = super::plist_string(&archive.join("Info.plist"), "ApplicationProperties.Team")?;
    ensure!(
        manual.is_none_or(|manual| manual.team == team),
        "The archive was signed for another team"
    );
    fs::write(
        directory.join("ExportOptions.plist"),
        signing::export_options(manual, bundle),
    )?;
    let exported = directory.join("export");
    logged(
        root,
        "app-store-export",
        &mut export_command(&directory, root, manual),
    )?;
    drop(ci_signing);
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
    verify_bundle(
        root,
        &unpacked.join("Payload/PublicPhonebook.app"),
        &team,
        build,
    )?;
    require_current_sources(root, &sources)?;
    let revision = super::super::checked(
        Command::new("git")
            .current_dir(root)
            .args(["rev-parse", "HEAD"]),
    )?;
    let sha256 = crate::sha256_hex(fs::read(ipa)?);
    let sbom = json!({"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"metadata":{"component":{"type":"application","name":Environment::Production.identity().1,"version":"1.0","hashes":[{"alg":"SHA-256","content":sha256}]}},"components":[{"type":"library","name":"PhonebookCore","version":"1.0","licenses":[{"expression":"MIT OR Apache-2.0"}],"scope":"required"},{"type":"library","name":"PhonebookKit","version":"1.0","licenses":[{"expression":"MIT OR Apache-2.0"}],"scope":"required"},{"type":"data","name":"Lucide icons","licenses":[{"license":{"id":"ISC"}}],"scope":"required"},{"type":"data","name":"Feather-derived icons","licenses":[{"license":{"id":"MIT"}}],"scope":"required"}],"properties":[{"name":"phonebook:platform-dependencies","value":"Apple iOS frameworks, Swift runtime, and SQLite are supplied by iOS; no third-party Swift packages are linked."}]});
    fs::write(
        directory.join("sbom.cdx.json"),
        serde_json::to_vec_pretty(&sbom)?,
    )?;
    let (purpose, signing_record, pending) = if ci {
        (
            "TestFlight candidate signed in the protected workflow; App Store submission stays with the owner",
            "ci",
            json!([
                "TestFlight upload and processing",
                "owner App Store submission and release"
            ]),
        )
    } else {
        (
            "private App Store preparation; no upload or submission",
            "local",
            json!([
                "clean owner-approved source revision",
                "current full candidate assurance",
                "public production API and privacy URL verification",
                "store screenshots and final declarations",
                "owner authorization for upload, submission, and publication"
            ]),
        )
    };
    let manifest = json!({"format":1,"purpose":purpose,"signing":signing_record,"source_revision":String::from_utf8(revision.stdout)?.trim(),"working_tree_dirty":dirty,"source_sha256":sources,"receipts":receipts,"version":"1.0","build":build.value(),"bundle":bundle,"archive":archive,"artifact":ipa,"sha256":sha256,"signature":"verified with production identities, app group, build number, and get-task-allow=false for the app and its extension","release_eligible":ci && !dirty && !receipts.is_empty(),"pending":pending});
    fs::write(
        directory.join("candidate.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    fs::write(
        root.join("target/ios/app-store-candidate.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    println!(
        "PASS: {signing_record}-signed App Store archive and IPA for build {build}; production identity, signature, extensions, notices, privacy manifests, SBOM, and SHA-256 checked at {}",
        directory.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn rendered(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn package_optimization_follows_swift_build_configuration_names() {
        for debug in [
            "Debug",
            "VerificationDebug",
            "ProductionDebug",
            "DevelopmentRelease",
        ] {
            assert!(packages_build_debug(debug), "{debug}");
        }
        for release in ["Release", "DevRelease", "VerificationRelease"] {
            assert!(!packages_build_debug(release), "{release}");
        }
        assert!(packages_build_debug("QADEBUGRelease"));
    }

    #[test]
    fn both_bundles_take_their_build_number_from_the_build_setting() -> Result<()> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for file in [
            "ios/Config/App-Info.plist",
            "ios/Config/CallDirectory-Info.plist",
        ] {
            let xml = fs::read_to_string(root.join(file))?;
            let document = roxmltree::Document::parse_with_options(
                &xml,
                roxmltree::ParsingOptions {
                    allow_dtd: true,
                    ..roxmltree::ParsingOptions::default()
                },
            )?;
            let properties = signing::entries(
                document
                    .root_element()
                    .first_element_child()
                    .context("The property list is empty")?,
            )?;
            let version = properties
                .get("CFBundleVersion")
                .copied()
                .with_context(|| format!("{file} has no CFBundleVersion"))?;
            assert_eq!(
                signing::text(version)?,
                "$(CURRENT_PROJECT_VERSION)",
                "{file}"
            );
        }
        Ok(())
    }

    #[test]
    fn ci_archives_sign_manually_without_account_access() -> Result<()> {
        let build = BuildNumber::from_run(42, 3)?;
        let directory = Path::new("/build/app-store-run");
        let manual = ManualSigning {
            team: "ABCDE12345".to_owned(),
            identity: "Apple Distribution: Example Owner (ABCDE12345)".to_owned(),
            keychain: PathBuf::from("/runner/temp/testflight-signing.keychain-db"),
            app_profile: "0f8fad5b-d9cb-469f-a165-70867728950e".to_owned(),
            extension_profile: "7c9e6679-7425-40de-944b-e07fc1f90ae7".to_owned(),
        };
        let ci = rendered(&archive_command(
            Path::new("/repo"),
            directory,
            Some(&manual),
            build,
        ));
        assert!(
            !ci.iter()
                .any(|argument| argument == "-allowProvisioningUpdates")
        );
        assert_eq!(ci.last().map(String::as_str), Some("archive"));
        for setting in signing::archive_settings(Some(&manual), build) {
            assert!(ci.contains(&setting), "{setting}");
        }
        assert!(ci.contains(&"/build/app-store-run/PublicPhonebook.xcarchive".to_owned()));
        let local = rendered(&archive_command(
            Path::new("/repo"),
            directory,
            None,
            BuildNumber::LOCAL,
        ));
        assert!(
            local
                .iter()
                .any(|argument| argument == "-allowProvisioningUpdates")
        );
        assert!(local.contains(&"CURRENT_PROJECT_VERSION=1".to_owned()));
        assert!(
            !local
                .iter()
                .any(|argument| argument.starts_with("CODE_SIGN_STYLE"))
        );
        let export = rendered(&export_command(
            directory,
            Path::new("/repo"),
            Some(&manual),
        ));
        assert_eq!(
            export,
            [
                "-quiet",
                "-exportArchive",
                "-archivePath",
                "/build/app-store-run/PublicPhonebook.xcarchive",
                "-exportOptionsPlist",
                "/build/app-store-run/ExportOptions.plist",
                "-exportPath",
                "/build/app-store-run/export"
            ]
        );
        assert!(
            rendered(&export_command(directory, Path::new("/repo"), None))
                .contains(&"-allowProvisioningUpdates".to_owned())
        );
        Ok(())
    }
}
