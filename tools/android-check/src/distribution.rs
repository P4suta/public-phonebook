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

pub fn store_assets(project: &Path, check: bool) -> Result<()> {
    for name in ["icon", "feature-graphic"] {
        let source = project.join(format!("android/store/{name}.svg"));
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactReceipt {
    name: String,
    sha256: String,
    bytes: u64,
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
    version: &'static str,
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

pub fn build(project: &Path) -> Result<()> {
    crate::require_current_release(project)?;
    let signing: Signing = serde_json::from_slice(
        &fs::read(location()?.join("signing.json"))
            .context("Run android-check signing-init or configure an existing upload identity")?,
    )?;
    ensure!(
        signing.key_alias == KEY_ALIAS && signing.keychain_service == SERVICE,
        "Unrecognized local signing configuration"
    );
    let secret = password(&signing)?;
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
    let mut build = Command::new("gradle");
    build
        .current_dir(project.join("android"))
        .env("PHONEBOOK_ANDROID_KEYSTORE", &signing.key_store)
        .env("PHONEBOOK_ANDROID_KEY_ALIAS", &signing.key_alias)
        .env("PHONEBOOK_ANDROID_STORE_PASSWORD", &secret)
        .env("PHONEBOOK_ANDROID_KEY_PASSWORD", &secret)
        .args([
            "--no-configuration-cache",
            "--no-daemon",
            ":app:assembleProductionRelease",
            ":app:bundleProductionRelease",
            "--console=plain",
        ]);
    run(build)?;
    let destination = project.join("target/android/distribution");
    fs::create_dir_all(&destination)?;
    let sbom = project.join("android/app/build/reports/cyclonedx-direct/bom.json");
    audit_dependencies(&sbom, &destination)?;
    fs::copy(&sbom, destination.join("sbom.cdx.json"))?;
    let apk = destination.join("public-phonebook-1.0.0.apk");
    let aab = destination.join("public-phonebook-1.0.0.aab");
    fs::copy(
        project.join("android/app/build/outputs/apk/production/release/app-production-release.apk"),
        &apk,
    )?;
    fs::copy(
        project
            .join("android/app/build/outputs/bundle/productionRelease/app-production-release.aab"),
        &aab,
    )?;
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
            version: "1.0.0",
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

fn audit_dependencies(sbom: &Path, destination: &Path) -> Result<()> {
    let document: serde_json::Value = serde_json::from_slice(&fs::read(sbom)?)?;
    ensure!(
        document["bomFormat"] == "CycloneDX"
            && document["metadata"]["component"]["version"] == "1.0.0",
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
