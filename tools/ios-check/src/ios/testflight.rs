use super::{
    build_number::BuildNumber,
    logged, require_current_sources,
    signing::{decoded_secret, scratch_directory, secret, uuid, write_private},
};
use crate::locations::{APP_STORE_CONNECT_BUILDS, CURL};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

pub(super) const KEY_ID: &str = "APP_STORE_CONNECT_KEY_ID";
pub(super) const ISSUER_ID: &str = "APP_STORE_CONNECT_ISSUER_ID";
pub(super) const PRIVATE_KEY: &str = "APP_STORE_CONNECT_PRIVATE_KEY_BASE64";
const PRIVATE_KEY_HEADER: &str = "-----BEGIN PRIVATE KEY-----";
const KEY_ID_LENGTH: usize = 10;
const APP_APPLE_ID: &str = "6828899028";
const MARKETING_VERSION: &str = "1.0";
const POLL_INTERVAL: Duration = Duration::from_secs(60);
const MAXIMUM_POLLS: u32 = 60;
const MAXIMUM_CONSECUTIVE_TRANSIENT_FAILURES: u32 = 5;
const REQUEST_TIMEOUT_SECONDS: &str = "30";
const STATUS_MARKER: &str = "phonebook-http-status=";
const HTTP_OK: u16 = 200;
const HTTP_TOO_MANY_REQUESTS: u16 = 429;
const HTTP_SERVER_ERRORS: std::ops::RangeInclusive<u16> = 500..=599;
const REDACTED: &str = "[redacted]";
const TOKEN_SEGMENTS: usize = 3;

struct ApiKey {
    id: String,
    issuer: String,
    file: PathBuf,
    _directory: tempfile::TempDir,
}

fn admit_key(id: &str, issuer: &str, private_key: &[u8]) -> Result<()> {
    ensure!(
        id.len() == KEY_ID_LENGTH
            && id
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()),
        "{KEY_ID} must be a ten-character App Store Connect key identifier"
    );
    ensure!(uuid(issuer), "{ISSUER_ID} must be a UUID");
    ensure!(
        std::str::from_utf8(private_key)
            .is_ok_and(|key| key.trim_start().starts_with(PRIVATE_KEY_HEADER)),
        "{PRIVATE_KEY} must hold the base64 of an App Store Connect .p8 key"
    );
    Ok(())
}

impl ApiKey {
    fn from_environment() -> Result<Self> {
        let id = secret(KEY_ID)?.trim().to_owned();
        let issuer = secret(ISSUER_ID)?.trim().to_owned();
        let private_key = decoded_secret(PRIVATE_KEY)?;
        admit_key(&id, &issuer, &private_key)?;
        let directory = scratch_directory("app-store-connect-")?;
        let file = directory.path().join(format!("AuthKey_{id}.p8"));
        write_private(&file, &private_key)?;
        Ok(Self {
            id,
            issuer,
            file,
            _directory: directory,
        })
    }

    fn authentication(&self) -> [OsString; 6] {
        [
            "--api-key".into(),
            self.id.clone().into(),
            "--api-issuer".into(),
            self.issuer.clone().into(),
            "--p8-file-path".into(),
            self.file.clone().into(),
        ]
    }

    fn upload_arguments(&self, package: &Path) -> Vec<OsString> {
        let mut values = vec![
            OsString::from("altool"),
            "--upload-package".into(),
            package.into(),
        ];
        values.extend(self.authentication());
        values.extend(["--output-format".into(), "json".into()]);
        values
    }

    fn token_arguments(&self) -> Vec<OsString> {
        let mut values = vec![OsString::from("altool"), "--generate-jwt".into()];
        values.extend(self.authentication());
        values
    }

    fn token(&self) -> Result<String> {
        let output = super::without_secrets(&mut Command::new("xcrun"))
            .args(self.token_arguments())
            .output()
            .context("Start App Store Connect token creation")?;
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&output.stderr));
        ensure!(
            output.status.success(),
            "altool couldn't create an App Store Connect token: {}",
            redacted(&text).trim()
        );
        token(&text)
    }
}

fn is_token(value: &str) -> bool {
    let segments = value.split('.').collect::<Vec<_>>();
    segments.len() == TOKEN_SEGMENTS
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        })
}

fn token(output: &str) -> Result<String> {
    let tokens = output
        .lines()
        .map(str::trim)
        .filter(|line| is_token(line))
        .collect::<Vec<_>>();
    let [value] = tokens.as_slice() else {
        bail!(
            "altool printed {} App Store Connect tokens instead of one",
            tokens.len()
        );
    };
    Ok((*value).to_owned())
}

fn redacted(text: &str) -> String {
    text.split_inclusive(char::is_whitespace)
        .map(|word| {
            if is_token(word.trim_end()) {
                word.replacen(word.trim_end(), REDACTED, 1)
            } else {
                word.to_owned()
            }
        })
        .collect()
}

fn builds_url(build: BuildNumber) -> String {
    format!(
        "{APP_STORE_CONNECT_BUILDS}?filter%5Bapp%5D={APP_APPLE_ID}&filter%5Bversion%5D={build}&filter%5BpreReleaseVersion.version%5D={MARKETING_VERSION}&filter%5BpreReleaseVersion.platform%5D=IOS&fields%5Bbuilds%5D=version,processingState&limit=2"
    )
}

fn curl_arguments() -> [&'static str; 9] {
    [
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--max-time",
        REQUEST_TIMEOUT_SECONDS,
        "--config",
        "-",
    ]
}

fn curl_configuration(url: &str, token: &str) -> String {
    format!(
        "url = \"{url}\"\nheader = \"Authorization: Bearer {token}\"\nheader = \"Accept: application/json\"\nwrite-out = \"%{{stderr}}\\n{STATUS_MARKER}%{{http_code}}\\n\"\n"
    )
}

fn status(stderr: &str) -> Option<u16> {
    stderr
        .lines()
        .filter_map(|line| line.trim().strip_prefix(STATUS_MARKER))
        .next_back()?
        .parse()
        .ok()
        .filter(|code| *code != 0)
}

#[derive(Debug, PartialEq, Eq)]
enum BuildState {
    NotVisible,
    Processing,
    Valid,
}

#[derive(Debug, PartialEq, Eq)]
enum Poll {
    Transient(String),
    Observed(BuildState),
}

fn processing(body: &Value, build: BuildNumber) -> Result<BuildState> {
    let builds = body["data"]
        .as_array()
        .context("App Store Connect returned no build list")?;
    match builds.as_slice() {
        [] => Ok(BuildState::NotVisible),
        [record] => {
            ensure!(
                record["attributes"]["version"] == build.to_string(),
                "App Store Connect returned a build other than {build}"
            );
            match record["attributes"]["processingState"].as_str() {
                Some("PROCESSING") => Ok(BuildState::Processing),
                Some("VALID") => Ok(BuildState::Valid),
                Some(state @ ("FAILED" | "INVALID")) => {
                    bail!("App Store Connect marked build {build} {state}")
                }
                state => bail!("App Store Connect reported an unknown processing state {state:?}"),
            }
        }
        _ => bail!("App Store Connect returned more than one build {build}"),
    }
}

fn api_errors(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| {
            value["errors"].as_array().map(|errors| {
                errors
                    .iter()
                    .filter_map(|error| error["detail"].as_str().or(error["title"].as_str()))
                    .collect::<Vec<_>>()
                    .join("; ")
            })
        })
        .unwrap_or_default()
}

fn poll(status: Option<u16>, body: &[u8], build: BuildNumber) -> Result<Poll> {
    match status {
        None => Ok(Poll::Transient("no HTTP response".to_owned())),
        Some(HTTP_OK) => Ok(Poll::Observed(processing(
            &serde_json::from_slice(body).context("App Store Connect returned malformed JSON")?,
            build,
        )?)),
        Some(code) if code == HTTP_TOO_MANY_REQUESTS || HTTP_SERVER_ERRORS.contains(&code) => {
            Ok(Poll::Transient(format!("HTTP {code}")))
        }
        Some(code) => bail!(
            "App Store Connect refused the build query with HTTP {code}: {}",
            api_errors(body)
        ),
    }
}

fn query(url: &str, token: &str, build: BuildNumber) -> Result<Poll> {
    let mut child = super::without_secrets(&mut Command::new(CURL))
        .args(curl_arguments())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("Start the App Store Connect build query")?;
    child
        .stdin
        .take()
        .context("The build query has no input")?
        .write_all(curl_configuration(url, token).as_bytes())?;
    let output = child.wait_with_output()?;
    let stderr = redacted(&String::from_utf8_lossy(&output.stderr));
    let code = status(&stderr);
    if !output.status.success() {
        return Ok(Poll::Transient(format!(
            "curl exited with {}: {}",
            output.status,
            stderr
                .lines()
                .filter(|line| !line.starts_with(STATUS_MARKER))
                .collect::<Vec<_>>()
                .join(" ")
                .trim()
        )));
    }
    poll(code, &output.stdout, build)
}

fn wait_for_processing(key: &ApiKey, build: BuildNumber) -> Result<u32> {
    let url = builds_url(build);
    let mut transient = 0;
    for attempt in 1..=MAXIMUM_POLLS {
        match query(&url, &key.token()?, build)? {
            Poll::Observed(BuildState::Valid) => return Ok(attempt),
            Poll::Observed(state) => {
                transient = 0;
                println!("TestFlight processing of build {build}: {state:?} at poll {attempt}");
            }
            Poll::Transient(reason) => {
                transient += 1;
                ensure!(
                    transient < MAXIMUM_CONSECUTIVE_TRANSIENT_FAILURES,
                    "App Store Connect failed {transient} consecutive build queries; last: {reason}"
                );
                println!("TestFlight processing query {attempt} failed temporarily: {reason}");
            }
        }
        if attempt < MAXIMUM_POLLS {
            thread::sleep(POLL_INTERVAL);
        }
    }
    bail!(
        "Processing of build {build} wasn't confirmed within {MAXIMUM_POLLS} polls; the result is inconclusive, and App Store Connect may still finish it"
    )
}

struct Candidate {
    package: PathBuf,
    build: BuildNumber,
    sha256: String,
    revision: String,
}

fn admit_candidate(record: &Value) -> Result<(PathBuf, BuildNumber, String)> {
    ensure!(
        record["signing"] == "ci" && record["release_eligible"] == true,
        "TestFlight accepts only a release-eligible archive from `archive --signing ci`"
    );
    let build = BuildNumber::new(
        record["build"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .context("The archive record has no build number")?,
    )?;
    ensure!(build.is_ci(), "The archive record has a local build number");
    let package = PathBuf::from(
        record["artifact"]
            .as_str()
            .context("The archive record names no package")?,
    );
    let sha256 = record["sha256"]
        .as_str()
        .context("The archive record has no package digest")?
        .to_owned();
    Ok((package, build, sha256))
}

fn candidate(root: &Path) -> Result<Candidate> {
    let record: Value = serde_json::from_slice(
        &fs::read(root.join("target/ios/app-store-candidate.json"))
            .context("Run `archive --signing ci` before `testflight`")?,
    )?;
    let (package, build, sha256) = admit_candidate(&record)?;
    ensure!(
        format!("{:x}", Sha256::digest(fs::read(&package)?)) == sha256,
        "The archived package changed after verification"
    );
    let recorded = record["source_sha256"]
        .as_object()
        .context("The archive record has no source digests")?
        .iter()
        .map(|(path, digest)| {
            Ok((
                path.clone(),
                digest.as_str().context("Invalid source digest")?.to_owned(),
            ))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
    require_current_sources(root, &recorded)?;
    let revision = super::super::checked(
        Command::new("git")
            .current_dir(root)
            .args(["rev-parse", "HEAD"]),
    )?;
    let revision = String::from_utf8(revision.stdout)?.trim().to_owned();
    ensure!(
        record["source_revision"] == revision,
        "The archive record belongs to another revision"
    );
    Ok(Candidate {
        package,
        build,
        sha256,
        revision,
    })
}

pub(super) fn run(root: &Path) -> Result<()> {
    let receipt = root.join("target/ios/testflight-receipt.json");
    if receipt.exists() {
        fs::remove_file(&receipt)?;
    }
    let candidate = candidate(root)?;
    let key = ApiKey::from_environment()?;
    logged(
        root,
        "testflight-upload",
        Command::new("xcrun").args(key.upload_arguments(&candidate.package)),
    )?;
    println!(
        "TestFlight upload accepted for build {}; waiting for processing",
        candidate.build
    );
    let polls = wait_for_processing(&key, candidate.build)?;
    fs::write(
        &receipt,
        serde_json::to_vec_pretty(&json!({
            "format":1,"result":"passed","app_apple_id":APP_APPLE_ID,"version":MARKETING_VERSION,
            "build":candidate.build.value(),"sha256":candidate.sha256,"source_revision":candidate.revision,
            "upload":"xcrun altool --upload-package with an App Store Connect API key",
            "processing_state":"VALID","processing_polls":polls,
            "not_done":["TestFlight group assignment","App Store submission"]
        }))?,
    )?;
    println!(
        "PASS: build {} uploaded to TestFlight and processed as VALID after {polls} polls",
        candidate.build
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ISSUER: &str = "57246542-96fe-1a63-e053-0824d011072a";
    const TOKEN: &str = "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ4In0.c2lnbmF0dXJl";
    const BANNER: &str = "Running altool at path '/Applications/Xcode.app/Contents/SharedFrameworks/ContentDelivery.framework/Resources/altool'...";

    fn key() -> Result<ApiKey> {
        let directory = tempfile::tempdir()?;
        Ok(ApiKey {
            id: "ABC123DEF4".to_owned(),
            issuer: ISSUER.to_owned(),
            file: directory.path().join("AuthKey_ABC123DEF4.p8"),
            _directory: directory,
        })
    }

    fn rendered(values: Vec<OsString>) -> Vec<String> {
        values
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn upload_and_token_commands_use_the_api_key_file_and_never_the_key_text() -> Result<()> {
        let key = key()?;
        let file = key.file.display().to_string();
        assert_eq!(
            rendered(key.upload_arguments(Path::new("/build/export/PublicPhonebook.ipa"))),
            [
                "altool",
                "--upload-package",
                "/build/export/PublicPhonebook.ipa",
                "--api-key",
                "ABC123DEF4",
                "--api-issuer",
                ISSUER,
                "--p8-file-path",
                &file,
                "--output-format",
                "json"
            ]
        );
        assert_eq!(
            rendered(key.token_arguments()),
            [
                "altool",
                "--generate-jwt",
                "--api-key",
                "ABC123DEF4",
                "--api-issuer",
                ISSUER,
                "--p8-file-path",
                &file
            ]
        );
        Ok(())
    }

    #[test]
    fn api_keys_must_have_apple_identifiers_and_a_private_key() {
        let pem = format!("{PRIVATE_KEY_HEADER}\nMIGTAgEA\n-----END PRIVATE KEY-----\n");
        assert!(admit_key("ABC123DEF4", ISSUER, pem.as_bytes()).is_ok());
        for (id, issuer, private_key) in [
            ("abc123def4", ISSUER, pem.as_str()),
            ("ABC123DEF", ISSUER, pem.as_str()),
            ("ABC123DEF4", "57246542-96fe-1a63-e053", pem.as_str()),
            ("ABC123DEF4", ISSUER, "MIGTAgEA"),
        ] {
            assert!(admit_key(id, issuer, private_key.as_bytes()).is_err());
        }
    }

    #[test]
    fn exactly_one_token_is_taken_from_the_altool_output() -> Result<()> {
        assert_eq!(token(&format!("{BANNER}\n\n{TOKEN}\n"))?, TOKEN);
        assert!(token(BANNER).is_err());
        assert!(token(&format!("{TOKEN}\n{TOKEN}\n")).is_err());
        assert!(token("a.b\nheader..signature\n").is_err());
        Ok(())
    }

    #[test]
    fn tokens_are_redacted_from_diagnostics() {
        let text = format!("{BANNER}\nERROR: rejected {TOKEN} for upload\n{TOKEN}");
        let clean = redacted(&text);
        assert!(!clean.contains(TOKEN));
        assert_eq!(clean.matches(REDACTED).count(), 2);
        assert!(clean.contains(BANNER));
    }

    #[test]
    fn the_build_query_is_scoped_to_the_app_version_platform_and_build() -> Result<()> {
        let build = BuildNumber::from_run(42, 3)?;
        assert_eq!(
            builds_url(build),
            format!(
                "{APP_STORE_CONNECT_BUILDS}?filter%5Bapp%5D=6828899028&filter%5Bversion%5D=4203&filter%5BpreReleaseVersion.version%5D=1.0&filter%5BpreReleaseVersion.platform%5D=IOS&fields%5Bbuilds%5D=version,processingState&limit=2"
            )
        );
        let configuration = curl_configuration(&builds_url(build), TOKEN);
        assert!(configuration.contains(&format!("header = \"Authorization: Bearer {TOKEN}\"\n")));
        assert!(configuration.contains(&format!("url = \"{}\"\n", builds_url(build))));
        assert!(
            curl_arguments()
                .iter()
                .all(|argument| !argument.contains(TOKEN))
        );
        assert_eq!(curl_arguments()[7..], ["--config", "-"]);
        Ok(())
    }

    #[test]
    fn http_status_is_read_from_the_marker() {
        assert_eq!(status(&format!("\n{STATUS_MARKER}200\n")), Some(HTTP_OK));
        assert_eq!(
            status(&format!(
                "curl: (6) Could not resolve host\n{STATUS_MARKER}000\n"
            )),
            None
        );
        assert_eq!(status("curl: (28) Operation timed out\n"), None);
    }

    #[test]
    fn processing_ends_only_when_the_exact_build_is_valid() -> Result<()> {
        let build = BuildNumber::from_run(42, 3)?;
        let record = |state: &str| json!({"data":[{"type":"builds","id":"1","attributes":{"version":"4203","processingState":state}}]});
        assert_eq!(
            processing(&json!({"data":[]}), build)?,
            BuildState::NotVisible
        );
        assert_eq!(
            processing(&record("PROCESSING"), build)?,
            BuildState::Processing
        );
        assert_eq!(processing(&record("VALID"), build)?, BuildState::Valid);
        for state in ["FAILED", "INVALID", "READY", ""] {
            assert!(processing(&record(state), build).is_err(), "{state}");
        }
        let mut other = record("VALID");
        other["data"][0]["attributes"]["version"] = json!("4202");
        assert!(processing(&other, build).is_err());
        let mut twice = record("VALID");
        twice["data"]
            .as_array_mut()
            .into_iter()
            .for_each(|builds| builds.push(builds[0].clone()));
        assert!(processing(&twice, build).is_err());
        assert!(processing(&json!({"errors":[]}), build).is_err());
        Ok(())
    }

    #[test]
    fn authorization_failures_stop_and_throttling_or_outages_retry() -> Result<()> {
        let build = BuildNumber::from_run(42, 3)?;
        let body = br#"{"data":[{"attributes":{"version":"4203","processingState":"VALID"}}]}"#;
        assert_eq!(
            poll(Some(HTTP_OK), body, build)?,
            Poll::Observed(BuildState::Valid)
        );
        assert!(matches!(poll(None, b"", build)?, Poll::Transient(_)));
        for code in [HTTP_TOO_MANY_REQUESTS, 500, 503] {
            assert!(
                matches!(poll(Some(code), b"", build)?, Poll::Transient(_)),
                "{code}"
            );
        }
        let refused = br#"{"errors":[{"status":"401","title":"Authentication failed","detail":"Provide a properly configured and signed bearer token."}]}"#;
        for code in [400, 401, 403, 404] {
            let error = poll(Some(code), refused, build)
                .err()
                .context("A refused query was retried")?;
            assert!(format!("{error:#}").contains("properly configured"));
        }
        assert!(poll(Some(HTTP_OK), b"not json", build).is_err());
        Ok(())
    }

    #[test]
    fn only_release_eligible_ci_archives_reach_testflight() -> Result<()> {
        let record = json!({"signing":"ci","release_eligible":true,"build":4203,"artifact":"/build/export/PublicPhonebook.ipa","sha256":"a".repeat(64)});
        let (package, build, _) = admit_candidate(&record)?;
        assert_eq!(package, Path::new("/build/export/PublicPhonebook.ipa"));
        assert_eq!(build.to_string(), "4203");
        for (field, value) in [
            ("signing", json!("local")),
            ("release_eligible", json!(false)),
            ("build", json!(1)),
            ("build", json!(0)),
            ("build", json!("4203")),
            ("build", json!(u64::from(u32::MAX) + 1)),
            ("artifact", Value::Null),
            ("sha256", Value::Null),
        ] {
            let mut invalid = record.clone();
            invalid[field] = value;
            assert!(admit_candidate(&invalid).is_err(), "{field}");
        }
        Ok(())
    }
}
