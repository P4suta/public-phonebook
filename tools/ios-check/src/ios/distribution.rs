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

mod linked_targets;

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
    root: &Path,
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
        ("MARKETING_VERSION", super::marketing_version(root)?),
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
            && metadata["version"] == super::marketing_version(root)?
            && metadata["releaseType"] == "AFTER_APPROVAL"
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
            validate(root, &target, config, environment, debug)?;
            if !visited.insert(target.target.clone()) {
                continue;
            }
            ensure!(
                validate(
                    root,
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
                    validate(root, &target, config, environment, debug).is_err(),
                    "Configuration negative control was accepted: {key}"
                );
                target.build_settings.remove(key);
                ensure!(
                    validate(root, &target, config, environment, debug).is_err(),
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
            info["CFBundleShortVersionString"] == super::marketing_version(root)?
                && info["MinimumOSVersion"] == "18.0",
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
            super::store_build::require_absent(&directory)?;
        }
    }
    Ok(())
}

pub(super) struct ArchiveRequest {
    pub signing: Signing,
    pub require_receipts: bool,
    pub build: Option<BuildNumber>,
    pub prepared: bool,
}

const UNSIGNED_DIRECTORY: &str = "target/ios/unsigned-store";

fn archive_files(directory: &Path) -> Result<BTreeMap<String, String>> {
    fn visit(root: &Path, relative: &Path, hashes: &mut BTreeMap<String, String>) -> Result<()> {
        for entry in fs::read_dir(root.join(relative))? {
            let entry = entry?;
            let path = relative.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                visit(root, &path, hashes)?;
            } else {
                ensure!(
                    entry.file_type()?.is_file(),
                    "Unsigned archives admit only regular files and directories"
                );
                hashes.insert(
                    path.to_string_lossy().into_owned(),
                    crate::sha256_hex(fs::read(entry.path())?),
                );
            }
        }
        Ok(())
    }
    let mut hashes = BTreeMap::new();
    visit(directory, Path::new(""), &mut hashes)?;
    ensure!(!hashes.is_empty(), "Unsigned archive is empty");
    Ok(hashes)
}

fn admit_prepared(
    record: &Value,
    build: BuildNumber,
    version: &str,
    sources: &BTreeMap<String, String>,
    files: &BTreeMap<String, String>,
) -> Result<()> {
    let facts = delivery_core::ArchiveFacts {
        format_matches: record["format"] == 1,
        unsigned: record["signing"] == "unsigned",
        build_matches: record["build"] == build.value(),
        version_matches: record["version"] == version,
        sources_match: record["sourceSha256"] == serde_json::to_value(sources)?,
        files_match: record["files"] == serde_json::to_value(files)?,
        nonempty: !files.is_empty(),
    };
    ensure!(
        delivery_core::admit_archive(facts),
        "The unsigned archive differs from the verified candidate"
    );
    Ok(())
}

/// The unsigned job's record, which carries the linked targets because the signing job never evaluates the package manifest.
fn prepared_record(
    version: &str,
    build: BuildNumber,
    sources: &BTreeMap<String, String>,
    files: &BTreeMap<String, String>,
    targets: &[String],
) -> Value {
    json!({"format":1,"signing":"unsigned","version":version,"build":build.value(),"sourceSha256":sources,"files":files,"linkedTargets":targets})
}

fn recorded_targets(record: &Value) -> Result<Vec<String>> {
    let targets = record["linkedTargets"]
        .as_array()
        .filter(|targets| !targets.is_empty())
        .context("The unsigned archive record names no linked targets")?
        .iter()
        .map(|target| {
            target
                .as_str()
                .map(str::to_owned)
                .with_context(|| format!("Recorded linked target {target} isn't a name"))
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        targets.windows(2).all(|pair| pair[0] < pair[1]),
        "Recorded linked targets must be sorted and unique"
    );
    for target in &targets {
        let mut characters = target.chars();
        ensure!(
            characters
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
                && characters
                    .all(|character| character.is_ascii_alphanumeric() || character == '_'),
            "Recorded linked target {target:?} isn't a Swift target name"
        );
    }
    Ok(targets)
}

/// The CycloneDX SBOM of the signed package, with one library component for each linked local target.
fn sbom(version: &str, sha256: &str, targets: &[String]) -> Value {
    let libraries = targets.iter().map(|name| {
        json!({"type":"library","name":name,"version":version,"licenses":[{"expression":"MIT OR Apache-2.0"}],"scope":"required"})
    });
    let notices = [
        json!({"type":"data","name":"Lucide icons","licenses":[{"license":{"id":"ISC"}}],"scope":"required"}),
        json!({"type":"data","name":"Feather-derived icons","licenses":[{"license":{"id":"MIT"}}],"scope":"required"}),
    ];
    json!({"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"metadata":{"component":{"type":"application","name":Environment::Production.identity().1,"version":version,"hashes":[{"alg":"SHA-256","content":sha256}]}},"components":libraries.chain(notices).collect::<Vec<_>>(),"properties":[{"name":"phonebook:platform-dependencies","value":"Apple iOS frameworks, Swift runtime, and SQLite are supplied by iOS; no third-party Swift packages are linked."}]})
}

pub(super) fn prepare_archive(root: &Path, build: BuildNumber) -> Result<()> {
    ensure!(
        build.is_ci(),
        "Prepared store archives require an allocated CI build identity"
    );
    delivery::proof::require_current(root)?;
    let sources = source_hashes(root)?;
    receipts::require(root, &sources)?;
    let directory = root.join(UNSIGNED_DIRECTORY);
    ensure!(
        !directory.exists(),
        "Preserve the existing unsigned archive and use its original run"
    );
    fs::create_dir_all(&directory)?;
    let mut command = archive_command(root, &directory, None, build, false);
    command.args([
        "CODE_SIGNING_ALLOWED=NO",
        "CODE_SIGNING_REQUIRED=NO",
        "CODE_SIGN_IDENTITY=",
    ]);
    logged(root, "unsigned-store-archive", &mut command)?;
    let archive = directory.join("PublicPhonebook.xcarchive");
    let files = archive_files(&archive)?;
    let targets = linked_targets::read(root)?;
    require_current_sources(root, &sources)?;
    fs::write(
        directory.join("candidate.json"),
        serde_json::to_vec_pretty(&prepared_record(
            &super::marketing_version(root)?,
            build,
            &sources,
            &files,
            &targets,
        ))?,
    )?;
    Ok(())
}

fn archive_command(
    root: &Path,
    directory: &Path,
    manual: Option<&ManualSigning>,
    build: BuildNumber,
    allow_account: bool,
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
    if allow_account {
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

fn prepare_requested_entitlements(root: &Path, archive: &Path) -> Result<()> {
    const GROUPS: &str = "com.apple.security.application-groups";
    let template = plist(root, &root.join("ios/Config/Shared.entitlements"))?;
    ensure!(
        template == json!({GROUPS: ["$(PHONEBOOK_APP_GROUP)"]}),
        "Unexpected archive entitlement request"
    );
    let bundle = Environment::Production.identity().0;
    let request = json!({GROUPS: [format!("group.{bundle}")]});
    let directory = archive.parent().context("The archive has no parent")?;
    let path = directory.join("requested-entitlements.plist");
    fs::write(&path, serde_json::to_vec(&request)?)?;
    logged(
        root,
        "requested-entitlements-plist",
        Command::new("plutil").args(["-convert", "xml1"]).arg(&path),
    )?;
    let app = archive.join("Products/Applications/PublicPhonebook.app");
    for target in [app.join("PlugIns/CallDirectory.appex"), app] {
        logged(
            root,
            "requested-entitlements-signature",
            Command::new("codesign")
                .args(["--force", "--sign", "-", "--entitlements"])
                .arg(&path)
                .arg("--generate-entitlement-der")
                .arg(target),
        )?;
    }
    Ok(())
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
        delivery::proof::require_current(root)?;
        receipts::require(root, &sources)?
    } else {
        Vec::new()
    };
    let bundle = Environment::Production.identity().0;
    let (prepared, recorded) = if request.prepared {
        let directory = root.join(UNSIGNED_DIRECTORY);
        let archive = directory.join("PublicPhonebook.xcarchive");
        let record: Value = serde_json::from_slice(&fs::read(directory.join("candidate.json"))?)?;
        admit_prepared(
            &record,
            build,
            &super::marketing_version(root)?,
            &sources,
            &archive_files(&archive)?,
        )?;
        (Some(archive), Some(recorded_targets(&record)?))
    } else {
        (None, None)
    };
    ensure!(
        !ci || prepared.is_some(),
        "CI signing cannot compile candidate-controlled build hooks"
    );
    let directory = tempfile::Builder::new()
        .prefix("app-store-")
        .tempdir_in(root.join("target/ios"))?
        .keep();
    let archive = directory.join("PublicPhonebook.xcarchive");
    if let Some(prepared) = &prepared {
        logged(
            root,
            "copy-unsigned-archive",
            Command::new("ditto").arg(prepared).arg(&archive),
        )?;
        prepare_requested_entitlements(root, &archive)?;
    }
    require_current_sources(root, &sources)?;
    let ci_signing = if ci {
        Some(signing::prepare(bundle)?)
    } else {
        None
    };
    let manual: Option<&ManualSigning> = ci_signing.as_ref().map(|prepared| &prepared.manual);
    if prepared.is_none() {
        logged(
            root,
            "app-store-archive",
            &mut archive_command(root, &directory, manual, build, manual.is_none()),
        )?;
    }
    let team = match manual {
        Some(manual) if request.prepared => manual.team.clone(),
        _ => super::plist_string(&archive.join("Info.plist"), "ApplicationProperties.Team")?,
    };
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
    let delivery = root.join("target/ios/store-delivery");
    fs::create_dir_all(&delivery)?;
    let preserved = delivery.join("PublicPhonebook.ipa");
    ensure!(
        !preserved.exists(),
        "Preserve the original signed candidate instead of rebuilding it"
    );
    fs::copy(ipa, &preserved)?;
    let version = super::marketing_version(root)?;
    let targets = match recorded {
        Some(targets) => targets,
        None => linked_targets::read(root)?,
    };
    let sbom = sbom(&version, &sha256, &targets);
    fs::write(
        directory.join("sbom.cdx.json"),
        serde_json::to_vec_pretty(&sbom)?,
    )?;
    fs::write(
        delivery.join("sbom.cdx.json"),
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
    let manifest = json!({"format":1,"purpose":purpose,"signing":signing_record,"source_revision":String::from_utf8(revision.stdout)?.trim(),"working_tree_dirty":dirty,"source_sha256":sources,"receipts":receipts,"version":version,"build":build.value(),"bundle":bundle,"archive":archive,"artifact":preserved.strip_prefix(root)?,"sha256":sha256,"signature":"verified with production identities, app group, build number, and get-task-allow=false for the app and its extension","release_eligible":ci && !dirty && !receipts.is_empty(),"pending":pending});
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

    #[test]
    fn signing_rejects_changed_unsigned_bytes_versions_builds_and_evidence() -> Result<()> {
        let build = BuildNumber::new(4201)?;
        let sources = BTreeMap::from([("App.swift".to_owned(), "source".to_owned())]);
        let files = BTreeMap::from([("PublicPhonebook".to_owned(), "unsigned-bytes".to_owned())]);
        let record = json!({"format":1,"signing":"unsigned","build":4201,"version":"1.0.0","sourceSha256":sources,"files":files});
        admit_prepared(&record, build, "1.0.0", &sources, &files)?;
        for property in [
            "format",
            "signing",
            "build",
            "version",
            "sourceSha256",
            "files",
        ] {
            let mut changed = record.clone();
            changed[property] = Value::Null;
            assert!(
                admit_prepared(&changed, build, "1.0.0", &sources, &files).is_err(),
                "{property}"
            );
        }
        assert!(admit_prepared(&record, build, "1.0.1", &sources, &files).is_err());
        assert!(
            admit_prepared(&record, BuildNumber::new(4202)?, "1.0.0", &sources, &files).is_err()
        );
        Ok(())
    }

    fn targets(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn the_sbom_lists_one_library_for_each_linked_target() {
        let linked = targets(&["PhonebookCore", "PhonebookKit", "PhonebookRanking"]);
        let document = sbom("1.2.0", "package-digest", &linked);
        let components = document["components"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let libraries = components
            .iter()
            .filter(|component| component["type"] == "library")
            .collect::<Vec<_>>();
        assert_eq!(
            libraries
                .iter()
                .map(|component| component["name"].clone())
                .collect::<Vec<_>>(),
            linked.iter().map(|name| json!(name)).collect::<Vec<_>>()
        );
        for library in libraries {
            assert_eq!(library["version"], "1.2.0");
            assert_eq!(library["scope"], "required");
            assert_eq!(
                library["licenses"],
                json!([{"expression":"MIT OR Apache-2.0"}])
            );
        }
        assert_eq!(
            components
                .iter()
                .filter(|component| component["type"] == "data")
                .map(|component| (component["name"].clone(), component["licenses"].clone()))
                .collect::<Vec<_>>(),
            [
                (json!("Lucide icons"), json!([{"license":{"id":"ISC"}}])),
                (
                    json!("Feather-derived icons"),
                    json!([{"license":{"id":"MIT"}}])
                ),
            ]
        );
        assert_eq!(components.len(), 5);
        assert_eq!(
            document["metadata"]["component"],
            json!({"type":"application","name":"Public Phonebook","version":"1.2.0","hashes":[{"alg":"SHA-256","content":"package-digest"}]})
        );
        assert_eq!(document["bomFormat"], "CycloneDX");
        assert_eq!(document["specVersion"], "1.6");
        assert_eq!(
            sbom("1.2.0", "package-digest", &targets(&["PhonebookCore"]))["components"]
                .as_array()
                .map(Vec::len),
            Some(3)
        );
    }

    #[test]
    fn prepared_archives_carry_their_linked_targets_to_signing() -> Result<()> {
        let build = BuildNumber::new(4201)?;
        let sources = BTreeMap::from([("App.swift".to_owned(), "source".to_owned())]);
        let files = BTreeMap::from([("PublicPhonebook".to_owned(), "unsigned-bytes".to_owned())]);
        let linked = targets(&[
            "PhonebookCore",
            "PhonebookKit",
            "PhonebookRanking",
            "_Private",
        ]);
        let record = prepared_record("1.0.0", build, &sources, &files, &linked);
        admit_prepared(&record, build, "1.0.0", &sources, &files)?;
        assert_eq!(recorded_targets(&record)?, linked);
        Ok(())
    }

    #[test]
    fn malformed_recorded_targets_are_refused() {
        for (linked, reason) in [
            (Value::Null, "names no linked targets"),
            (json!("PhonebookCore"), "names no linked targets"),
            (json!([]), "names no linked targets"),
            (json!(["PhonebookCore", 1]), "isn't a name"),
            (
                json!(["PhonebookKit", "PhonebookCore"]),
                "sorted and unique",
            ),
            (
                json!(["PhonebookCore", "PhonebookCore"]),
                "sorted and unique",
            ),
            (json!(["Phonebook Core"]), "isn't a Swift target name"),
            (json!(["1Core"]), "isn't a Swift target name"),
            (json!([""]), "isn't a Swift target name"),
            (json!(["Core-Kit"]), "isn't a Swift target name"),
        ] {
            let record = json!({"linkedTargets": linked});
            let error = recorded_targets(&record)
                .err()
                .unwrap_or_else(|| panic!("expected a refusal for {linked}"));
            assert!(error.to_string().contains(reason), "{linked}: {error}");
        }
    }
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
    fn both_bundles_take_their_versions_from_build_settings() -> Result<()> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for file in [
            "ios/Config/App-Info.plist",
            "ios/Config/App-Info-LocalNetworking.plist",
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
            for (key, setting) in [
                ("CFBundleVersion", "$(CURRENT_PROJECT_VERSION)"),
                ("CFBundleShortVersionString", "$(MARKETING_VERSION)"),
            ] {
                let version = properties
                    .get(key)
                    .copied()
                    .with_context(|| format!("{file} has no {key}"))?;
                assert_eq!(signing::text(version)?, setting, "{file}: {key}");
            }
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn generation_preserves_both_bundle_version_settings() -> Result<()> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let directory = tempfile::tempdir()?;
        let output = directory.path().join("spec.json");
        crate::checked(
            Command::new("xcodegen")
                .current_dir(root.join("ios"))
                .args(["dump", "--type", "json", "--quiet", "--file"])
                .arg(&output),
        )?;
        let specification: Value = serde_json::from_slice(&fs::read(output)?)?;
        for target in ["PublicPhonebook", "CallDirectory"] {
            for (key, setting) in [
                ("CFBundleVersion", "$(CURRENT_PROJECT_VERSION)"),
                ("CFBundleShortVersionString", "$(MARKETING_VERSION)"),
            ] {
                assert_eq!(
                    specification["targets"][target]["info"]["properties"][key], setting,
                    "{target}: {key}"
                );
            }
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn prepared_copies_carry_the_requested_app_group_without_private_keys() -> Result<()> {
        let root = tempfile::tempdir()?;
        let config = root.path().join("ios/Config");
        fs::create_dir_all(&config)?;
        let source_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        fs::copy(
            source_root.join("ios/Config/Shared.entitlements"),
            config.join("Shared.entitlements"),
        )?;
        let archive = root.path().join("PublicPhonebook.xcarchive");
        let app = archive.join("Products/Applications/PublicPhonebook.app");
        let extension = app.join("PlugIns/CallDirectory.appex");
        fs::create_dir_all(&extension)?;
        let source = root.path().join("fixture.c");
        fs::write(&source, "int main(void) { return 0; }\n")?;
        for (target, name, package) in [
            (&app, "PublicPhonebook", "APPL"),
            (&extension, "CallDirectory", "XPC!"),
        ] {
            fs::write(
                target.join("Info.plist"),
                format!(
                    "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>page.dial.fixture.{name}</string><key>CFBundleExecutable</key><string>{name}</string><key>CFBundlePackageType</key><string>{package}</string></dict></plist>"
                ),
            )?;
            crate::checked(
                Command::new("xcrun")
                    .arg("clang")
                    .arg(&source)
                    .arg("-o")
                    .arg(target.join(name)),
            )?;
        }
        let original = archive_files(&archive)?;
        for invalid in [
            json!({}),
            json!({"com.apple.security.application-groups":["group.another"]}),
            json!({"com.apple.security.application-groups":["$(PHONEBOOK_APP_GROUP)"],"get-task-allow":true}),
        ] {
            fs::write(
                config.join("Shared.entitlements"),
                serde_json::to_vec(&invalid)?,
            )?;
            let error = prepare_requested_entitlements(root.path(), &archive)
                .err()
                .context("An unexpected request was accepted")?;
            assert!(
                error
                    .to_string()
                    .contains("Unexpected archive entitlement request")
            );
            assert_eq!(archive_files(&archive)?, original);
        }
        fs::copy(
            source_root.join("ios/Config/Shared.entitlements"),
            config.join("Shared.entitlements"),
        )?;
        prepare_requested_entitlements(root.path(), &archive)?;
        for target in [extension, app] {
            crate::checked(
                Command::new("codesign")
                    .args(["--verify", "--deep", "--strict"])
                    .arg(&target),
            )?;
            let entitlement_path = root.path().join("observed-entitlements.plist");
            crate::checked(
                Command::new("codesign")
                    .args(["-d", "--entitlements"])
                    .arg(&entitlement_path)
                    .arg("--xml")
                    .arg(&target),
            )?;
            assert_eq!(
                plist(root.path(), &entitlement_path)?,
                json!({"com.apple.security.application-groups":["group.page.dial.publicphonebook"]})
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
            false,
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
            true,
        ));
        assert!(
            local
                .iter()
                .any(|argument| argument == "-allowProvisioningUpdates")
        );
        let unsigned = rendered(&archive_command(
            Path::new("/repo"),
            directory,
            None,
            build,
            false,
        ));
        assert!(
            !unsigned
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
