use crate::contract::{COMPILE_ANDROID_API, MINIMUM_ANDROID_API, TARGET_ANDROID_API};
use crate::{completed, file_digest, gradle, root, run, sdk, write_json};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const ACCOUNT: &str = "public-phonebook";
const SERVICE: &str = "page.dial.publicphonebook.upload-key";
const KEY_ALIAS: &str = "public-phonebook-upload";
const KEY_BITS: &str = "4096";
const KEY_DAYS: &str = "10950";
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const PRIVATE_FILE_MODE: u32 = 0o600;
const MINIMUM_DEPENDENCY_QUERIES: usize = 21;
const OSV_API_URL: &str = "https://api.osv.dev/v1/querybatch";

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn candidate_identity_and_each_artifact_are_required_before_signing() -> Result<()> {
        let directory = tempfile::tempdir()?;
        for name in UNSIGNED_FILES {
            fs::write(directory.path().join(name), name)?;
        }
        let files = unsigned_files(directory.path())?;
        let sources = BTreeMap::from([("apps/android/version.txt".to_owned(), "a".repeat(64))]);
        let candidate = serde_json::to_value(UnsignedCandidate {
            format: 1,
            source_commit: "a".repeat(40),
            version: "1.0.0".to_owned(),
            version_code: 101,
            signed: false,
            release_eligible: false,
            source_inputs: sources.clone(),
            artifacts: files.clone(),
        })?;
        let parsed = serde_json::from_value(candidate.clone())?;
        admit_unsigned(&parsed, &"a".repeat(40), "1.0.0", 101, &sources, &files)?;
        for (field, value) in [
            ("format", json!(2)),
            ("sourceCommit", json!("b".repeat(40))),
            ("version", json!("2.0.0")),
            ("versionCode", json!(102)),
            ("signed", json!(true)),
            ("releaseEligible", json!(true)),
            ("sourceInputs", json!({})),
            ("artifacts", json!([])),
        ] {
            let mut changed = candidate.clone();
            changed[field] = value;
            assert!(
                admit_unsigned(
                    &serde_json::from_value(changed)?,
                    &"a".repeat(40),
                    "1.0.0",
                    101,
                    &sources,
                    &files
                )
                .is_err()
            );
        }
        fs::write(directory.path().join("unsigned.apk"), "different bytes")?;
        assert!(
            admit_unsigned(
                &parsed,
                &"a".repeat(40),
                "1.0.0",
                101,
                &sources,
                &unsigned_files(directory.path())?
            )
            .is_err()
        );
        fs::write(directory.path().join("unsigned.apk"), "")?;
        assert!(unsigned_files(directory.path()).is_err());
        Ok(())
    }
}

pub fn store_assets(project: &Path, check: bool) -> Result<()> {
    for name in ["icon", "feature-graphic"] {
        let source = project.join(format!("apps/android/store/{name}.svg"));
        let destination = source.with_extension("png");
        let tree =
            resvg::usvg::Tree::from_data(&fs::read(&source)?, &resvg::usvg::Options::default())?;
        let size = tree.size().to_int_size();
        let mut pixels = resvg::tiny_skia::Pixmap::new(size.width(), size.height())
            .context("Invalid store graphic dimensions")?;
        resvg::render(
            &tree,
            resvg::tiny_skia::Transform::identity(),
            &mut pixels.as_mut(),
        );
        let png = pixels.encode_png()?;
        if check {
            ensure!(
                fs::read(&destination)? == png,
                "Store graphic differs from its vector source: {name}"
            );
        } else {
            fs::write(destination, png)?;
        }
    }
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Signing {
    key_store: PathBuf,
    key_alias: String,
    keychain_service: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactReceipt {
    name: String,
    sha256: String,
    bytes: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UnsignedCandidate {
    format: u32,
    source_commit: String,
    version: String,
    version_code: u32,
    signed: bool,
    release_eligible: bool,
    source_inputs: std::collections::BTreeMap<String, String>,
    artifacts: Vec<ArtifactReceipt>,
}

const UNSIGNED_FILES: [&str; 3] = ["unsigned.apk", "unsigned.aab", "sbom.cdx.json"];

fn unsigned_files(directory: &Path) -> Result<Vec<ArtifactReceipt>> {
    UNSIGNED_FILES
        .iter()
        .map(|name| {
            let path = directory.join(name);
            let metadata = fs::symlink_metadata(&path)?;
            ensure!(
                metadata.is_file() && metadata.len() > 0,
                "Unsigned artifacts must be nonempty ordinary files"
            );
            ArtifactReceipt::read(&path)
        })
        .collect()
}

pub fn prepare(project: &Path, build_number: u32) -> Result<()> {
    let destination = project.join("target/android/candidate");
    ensure!(
        !destination.exists(),
        "Preserve the existing Android candidate and use its original run"
    );
    delivery::proof::require_current(project)?;
    crate::require_current_proof(project)?;
    crate::mutation::require_current(project)?;
    let build_number = delivery_core::BuildNumber::new(build_number)
        .context("The build number is outside the Android store range")?;
    let sources = crate::source_refinement_with_model(project)?;
    let mut command = crate::gradle_command(project);
    command
        .env("ANDROID_HOME", crate::sdk()?)
        .env("PHONEBOOK_ANDROID_VERSION_CODE", build_number.to_string())
        .args([
            "--no-daemon",
            ":app:assembleProductionRelease",
            ":app:bundleProductionRelease",
            ":app:cyclonedxDirectBom",
            "--console=plain",
        ]);
    run(command)?;
    let parent = destination.parent().context("Missing candidate parent")?;
    fs::create_dir_all(parent)?;
    let temporary = tempfile::tempdir_in(parent)?;
    let directory = temporary.path();
    for (source, name) in [
        (
            "apps/android/app/build/outputs/apk/production/release/app-production-release-unsigned.apk",
            "unsigned.apk",
        ),
        (
            "apps/android/app/build/outputs/bundle/productionRelease/app-production-release.aab",
            "unsigned.aab",
        ),
        (
            "apps/android/app/build/reports/cyclonedx-direct/bom.json",
            "sbom.cdx.json",
        ),
    ] {
        fs::copy(project.join(source), directory.join(name))?;
    }
    let mut git = Command::new("git");
    git.current_dir(project).args(["rev-parse", "HEAD"]);
    let source_commit = String::from_utf8(completed(git)?.stdout)?.trim().to_owned();
    ensure!(
        crate::source_refinement_with_model(project)? == sources,
        "Android inputs changed while preparing the candidate"
    );
    write_json(
        &directory.join("manifest.json"),
        &UnsignedCandidate {
            format: 1,
            source_commit,
            version: app_version(project)?,
            version_code: build_number.value(),
            signed: false,
            release_eligible: false,
            source_inputs: sources,
            artifacts: unsigned_files(directory)?,
        },
    )?;
    fs::rename(directory, &destination)?;
    println!(
        "Prepared unsigned Android candidate: {}",
        destination.display()
    );
    Ok(())
}

fn admit_unsigned(
    record: &UnsignedCandidate,
    revision: &str,
    version: &str,
    build: u32,
    sources: &std::collections::BTreeMap<String, String>,
    artifacts: &[ArtifactReceipt],
) -> Result<()> {
    let facts = delivery_core::ArchiveFacts {
        format_matches: record.format == 1,
        unsigned: !record.signed && !record.release_eligible,
        build_matches: record.version_code == build,
        version_matches: record.version == version,
        sources_match: record.source_commit == revision && &record.source_inputs == sources,
        files_match: record.artifacts == artifacts,
        nonempty: artifacts.len() == UNSIGNED_FILES.len()
            && artifacts.iter().all(|artifact| artifact.bytes > 0),
    };
    ensure!(
        delivery_core::admit_archive(facts),
        "The unsigned Android candidate differs from the verified source or bytes"
    );
    Ok(())
}

impl ArtifactReceipt {
    fn read(path: &Path) -> Result<Self> {
        Ok(Self {
            name: path
                .file_name()
                .context("Missing artifact name")?
                .to_string_lossy()
                .into_owned(),
            sha256: file_digest(path)?,
            bytes: fs::metadata(path)?.len(),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DistributionManifest {
    repository: &'static str,
    source_commit: String,
    working_tree_dirty: bool,
    version: String,
    version_code: u32,
    application_id: &'static str,
    minimum_sdk: u32,
    target_sdk: u32,
    compile_sdk: u32,
    certificate_sha256: String,
    artifacts: Vec<ArtifactReceipt>,
    proof: ArtifactReceipt,
    device_checks: ArtifactReceipt,
    builder: &'static str,
    provenance: &'static str,
    publication: &'static str,
}

fn location() -> Result<PathBuf> {
    ensure!(
        cfg!(target_os = "macos"),
        "Signing uses the owner's macOS Keychain"
    );
    Ok(
        PathBuf::from(std::env::var_os("HOME").context("Missing user directory")?)
            .join(".config/public-phonebook/android"),
    )
}

fn password(signing: &Signing) -> Result<String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            ACCOUNT,
            "-s",
            &signing.keychain_service,
            "-w",
        ])
        .output()?;
    ensure!(
        output.status.success(),
        "Cannot read the upload password from Keychain"
    );
    let password = String::from_utf8(output.stdout)?.trim().to_owned();
    ensure!(!password.is_empty(), "The upload password is empty");
    Ok(password)
}

pub fn initialize() -> Result<()> {
    let directory = location()?;
    let record = directory.join("signing.json");
    ensure!(
        !record.exists() && !directory.join("upload.p12").exists(),
        "An upload identity already exists; reuse its local configuration"
    );
    fs::create_dir_all(&directory)?;
    private(&directory, true)?;
    let mut random = [0_u8; 32];
    getrandom::fill(&mut random)
        .map_err(|error| anyhow::anyhow!("Cannot create a signing password: {error}"))?;
    let secret: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let signing = Signing {
        key_store: directory.join("upload.p12"),
        key_alias: KEY_ALIAS.into(),
        keychain_service: SERVICE.into(),
    };
    let mut security = Command::new("security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    security
        .stdin
        .take()
        .context("Cannot open Keychain command input")?
        .write_all(
            format!("add-generic-password -U -a {ACCOUNT} -s {SERVICE} -w {secret}\n").as_bytes(),
        )?;
    ensure!(
        security.wait()?.success(),
        "Keychain refused the upload password"
    );
    let mut keytool = Command::new("keytool");
    keytool
        .env("PHONEBOOK_KEY_PASSWORD", &secret)
        .args([
            "-genkeypair",
            "-storetype",
            "PKCS12",
            "-keyalg",
            "RSA",
            "-keysize",
            KEY_BITS,
            "-validity",
            KEY_DAYS,
            "-dname",
            "CN=Public Phonebook Upload",
            "-alias",
            KEY_ALIAS,
            "-storepass:env",
            "PHONEBOOK_KEY_PASSWORD",
            "-keypass:env",
            "PHONEBOOK_KEY_PASSWORD",
            "-keystore",
        ])
        .arg(&signing.key_store);
    run(keytool)?;
    private(&signing.key_store, false)?;
    write_json(&record, &signing)?;
    private(&record, false)?;
    println!("Created an owner-local upload key; the password is stored in macOS Keychain");
    Ok(())
}

#[cfg(unix)]
fn private(path: &Path, directory: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(if directory {
            PRIVATE_DIRECTORY_MODE
        } else {
            PRIVATE_FILE_MODE
        }),
    )?;
    Ok(())
}
#[cfg(not(unix))]
fn private(_: &Path, _: bool) -> Result<()> {
    anyhow::bail!("Signing initialization requires macOS")
}

fn app_version(project: &Path) -> Result<String> {
    let path = project.join("apps/android/version.txt");
    ensure!(
        fs::metadata(&path)?.len() <= (delivery_core::Version::MAXIMUM_BYTES + 1) as u64,
        "Oversized Android version input"
    );
    let bytes = fs::read(path)?;
    Ok(
        delivery_core::Version::parse(bytes.strip_suffix(b"\n").unwrap_or(&bytes))
            .map_err(|error| anyhow::anyhow!("Invalid Android version: {error:?}"))?
            .to_string(),
    )
}

pub fn build(project: &Path, build_number: u32, prepared: bool) -> Result<()> {
    delivery::proof::require_current(project)?;
    let build_number = delivery_core::BuildNumber::new(build_number)
        .context("The Android build number is outside the store range")?;
    let version = app_version(project)?;
    crate::require_current_release(project)?;
    let signing: Signing = serde_json::from_slice(
        &fs::read(location()?.join("signing.json"))
            .context("Run android-check signing-init or configure an existing upload identity")?,
    )?;
    ensure!(
        signing.key_alias == KEY_ALIAS && signing.keychain_service == SERVICE,
        "Unrecognized local signing configuration"
    );
    gradle(
        project,
        &[
            "ktfmtCheck",
            "detekt",
            ":core:detektMain",
            ":data:detektDebug",
            ":app:detektVerificationDebug",
            ":core:test",
            ":data:testDebugUnitTest",
            ":app:testVerificationDebugUnitTest",
            ":app:lintProductionRelease",
            ":app:cyclonedxDirectBom",
        ],
    )?;
    if !prepared {
        prepare(project, build_number.value())?;
    }
    let directory = project.join("target/android/candidate");
    let candidate: UnsignedCandidate =
        serde_json::from_slice(&fs::read(directory.join("manifest.json"))?)?;
    let mut git = Command::new("git");
    git.current_dir(project).args(["rev-parse", "HEAD"]);
    let revision = String::from_utf8(completed(git)?.stdout)?;
    admit_unsigned(
        &candidate,
        revision.trim(),
        &version,
        build_number.value(),
        &crate::source_refinement_with_model(project)?,
        &unsigned_files(&directory)?,
    )?;
    let destination = project.join("target/android/distribution");
    fs::create_dir_all(&destination)?;
    let sbom = directory.join("sbom.cdx.json");
    audit_dependencies(&sbom, &destination, &version)?;
    fs::copy(&sbom, destination.join("sbom.cdx.json"))?;
    let apk = destination.join(format!("public-phonebook-{version}-{build_number}.apk"));
    let aab = destination.join(format!("public-phonebook-{version}-{build_number}.aab"));
    let secret = password(&signing)?;
    let mut sign_apk = Command::new(sdk()?.join("build-tools/36.0.0/apksigner"));
    sign_apk
        .env("PHONEBOOK_KEY_PASSWORD", &secret)
        .args(["sign", "--ks"])
        .arg(&signing.key_store)
        .args([
            "--ks-key-alias",
            &signing.key_alias,
            "--ks-pass",
            "env:PHONEBOOK_KEY_PASSWORD",
            "--key-pass",
            "env:PHONEBOOK_KEY_PASSWORD",
            "--out",
        ])
        .arg(&apk)
        .arg(directory.join("unsigned.apk"));
    run(sign_apk)?;
    let mut sign_aab = Command::new("jarsigner");
    sign_aab
        .env("PHONEBOOK_KEY_PASSWORD", &secret)
        .args(["-keystore"])
        .arg(&signing.key_store)
        .args([
            "-storetype",
            "PKCS12",
            "-storepass:env",
            "PHONEBOOK_KEY_PASSWORD",
            "-keypass:env",
            "PHONEBOOK_KEY_PASSWORD",
            "-signedjar",
        ])
        .arg(&aab)
        .arg(directory.join("unsigned.aab"))
        .arg(&signing.key_alias);
    run(sign_aab)?;
    let mut verify = Command::new(sdk()?.join("build-tools/36.0.0/apksigner"));
    verify
        .args([
            "verify",
            "--verbose",
            "--print-certs",
            "--min-sdk-version",
            "29",
        ])
        .arg(&apk);
    let apk_signature = completed(verify)?;
    fs::write(destination.join("apk-signature.txt"), &apk_signature.stdout)?;
    let mut verify = Command::new("jarsigner");
    verify
        .env("PHONEBOOK_KEY_PASSWORD", &secret)
        .args(["-verify", "-keystore"])
        .arg(&signing.key_store)
        .args(["-storepass:env", "PHONEBOOK_KEY_PASSWORD"])
        .arg(&aab)
        .arg(&signing.key_alias);
    let aab_signature = completed(verify)?;
    ensure!(
        String::from_utf8_lossy(&aab_signature.stdout).contains("jar verified"),
        "The bundle signature was not verified"
    );
    fs::write(destination.join("aab-signature.txt"), &aab_signature.stdout)?;
    let certificate = destination.join("upload-certificate.der");
    let mut export = Command::new("keytool");
    export
        .env("PHONEBOOK_KEY_PASSWORD", &secret)
        .args(["-exportcert", "-alias", &signing.key_alias, "-keystore"])
        .arg(&signing.key_store)
        .args(["-storepass:env", "PHONEBOOK_KEY_PASSWORD", "-file"])
        .arg(&certificate);
    run(export)?;
    let certificate_hash = file_digest(&certificate)?;
    ensure!(
        String::from_utf8_lossy(&apk_signature.stdout).contains(&certificate_hash),
        "APK certificate differs from the selected upload key"
    );
    let mut source = Command::new("git");
    source.current_dir(root()?).args(["rev-parse", "HEAD"]);
    let revision = String::from_utf8(completed(source)?.stdout)?
        .trim()
        .to_owned();
    let mut status = Command::new("git");
    status.current_dir(project).args(["status", "--porcelain"]);
    let dirty = !completed(status)?.stdout.is_empty();
    crate::require_current_release(project)?;
    let proof = destination.join("proof-receipt.json");
    fs::copy(project.join("target/android/proof/receipt.json"), &proof)?;
    let device_checks = destination.join("release-check.json");
    fs::copy(
        project.join("target/android/release-check.json"),
        &device_checks,
    )?;
    let artifacts = [apk, aab, destination.join("sbom.cdx.json")]
        .iter()
        .map(|path| ArtifactReceipt::read(path))
        .collect::<Result<Vec<_>>>()?;
    write_json(
        &destination.join("manifest.json"),
        &DistributionManifest {
            repository: "P4suta/public-phonebook",
            source_commit: revision,
            working_tree_dirty: dirty,
            version,
            version_code: build_number.value(),
            application_id: "page.dial.publicphonebook",
            minimum_sdk: MINIMUM_ANDROID_API,
            target_sdk: TARGET_ANDROID_API,
            compile_sdk: COMPILE_ANDROID_API,
            certificate_sha256: certificate_hash,
            artifacts,
            proof: ArtifactReceipt::read(&proof)?,
            device_checks: ArtifactReceipt::read(&device_checks)?,
            builder: "local-macos-pinned-mise-toolchain",
            provenance: "local-record-without-hosted-attestation",
            publication: "not-published",
        },
    )?;
    println!("Verified signed APK and AAB: {}", destination.display());
    Ok(())
}

fn audit_dependencies(sbom: &Path, destination: &Path, version: &str) -> Result<()> {
    let document: serde_json::Value = serde_json::from_slice(&fs::read(sbom)?)?;
    ensure!(
        document["bomFormat"] == "CycloneDX"
            && document["metadata"]["component"]["version"] == version,
        "Dependency inventory identifies another product"
    );
    let components = document["components"]
        .as_array()
        .context("Missing dependency components")?;
    let mut queries = Vec::new();
    for component in components {
        if component["group"] == "PublicPhonebook" {
            continue;
        }
        let licenses = component["licenses"]
            .as_array()
            .context("Missing dependency license")?;
        ensure!(
            !licenses.is_empty()
                && licenses.iter().all(|entry| {
                    matches!(entry["license"]["id"].as_str(), Some("Apache-2.0" | "MIT"))
                }),
            "Unreviewed dependency license for {}",
            component["name"]
        );
        let purl = component["purl"]
            .as_str()
            .context("Missing dependency package URL")?;
        ensure!(
            purl.starts_with("pkg:maven/"),
            "Unreviewed dependency ecosystem"
        );
        queries.push(json!({"package":{"purl":purl}}));
    }
    ensure!(
        queries.len() >= MINIMUM_DEPENDENCY_QUERIES,
        "The dependency scan inventory is incomplete"
    );
    let request = destination.join("osv-request.json");
    write_json(&request, &json!({"queries":queries}))?;
    let mut command = Command::new("curl");
    command
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--max-time",
            "60",
            "--header",
            "Content-Type: application/json",
            "--data-binary",
        ])
        .arg(format!("@{}", request.display()))
        .arg(OSV_API_URL);
    let output = completed(command)?;
    let response: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    fs::write(destination.join("osv-response.json"), &output.stdout)?;
    let results = response["results"]
        .as_array()
        .context("Missing dependency scan results")?;
    ensure!(
        results.len() == queries.len(),
        "The dependency scan returned an incomplete result set"
    );
    ensure!(
        results.iter().all(|result| result
            .get("vulns")
            .is_none_or(|vulns| vulns.as_array().is_some_and(Vec::is_empty))),
        "Dependency advisories require review; inspect osv-response.json"
    );
    write_json(
        &destination.join("dependency-assurance.json"),
        &json!({"sbomSha256":file_digest(sbom)?,"components":components.len(),"queriedPackages":queries.len(),"licenses":["Apache-2.0","MIT"],"knownAdvisories":0,"provider":OSV_API_URL}),
    )?;
    Ok(())
}
