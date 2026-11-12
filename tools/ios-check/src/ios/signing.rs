use super::build_number::BuildNumber;
use crate::locations::{
    CODESIGN, PROPERTY_LIST_DOCUMENT_TYPE, PROVISIONING_PROFILES, RANDOM_DEVICE,
    RUNNER_TEMPORARY_DIRECTORY, SECURITY,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fmt::Write as _,
    fs,
    io::{Read, Write as _},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

pub(super) const CERTIFICATE: &str = "APPLE_DISTRIBUTION_CERTIFICATE_BASE64";
pub(super) const CERTIFICATE_PASSWORD: &str = "APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD";
pub(super) const APP_PROFILE: &str = "APP_PROVISIONING_PROFILE_BASE64";
pub(super) const EXTENSION_PROFILE: &str = "CALL_DIRECTORY_PROVISIONING_PROFILE_BASE64";
pub(super) const WATCH_PROFILE: &str = "WATCH_PROVISIONING_PROFILE_BASE64";
pub(super) const KEYCHAIN: &str = "PHONEBOOK_SIGNING_KEYCHAIN";
pub(super) const EXTENSION_SUFFIX: &str = ".CallDirectory";
const KEYCHAIN_EXTENSION: &str = ".keychain-db";
const KEYCHAIN_PASSWORD_BYTES: usize = 32;
const KEYCHAIN_LOCK_SECONDS: &str = "21600";
const KEY_PARTITIONS: &str = "apple-tool:,apple:,codesign:";
const DISTRIBUTION_AUTHORITY: &str = "Apple Distribution: ";
const TEAM_IDENTIFIER_LENGTH: usize = 10;
const UUID_LENGTH: usize = 36;
const UUID_SEPARATORS: [usize; 4] = [8, 13, 18, 23];
const SHA1_HEX_LENGTH: usize = 40;
const PRIVATE_FILE_MODE: u32 = 0o600;

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum Signing {
    Local,
    Ci,
}

fn source_requirements(revision: &str) -> [(&str, &str); 6] {
    [
        ("GITHUB_ACTIONS", "true"),
        ("GITHUB_EVENT_NAME", "workflow_dispatch"),
        ("GITHUB_REPOSITORY", "P4suta/public-phonebook"),
        ("GITHUB_REF", "refs/heads/main"),
        (
            "GITHUB_WORKFLOW_REF",
            "P4suta/public-phonebook/.github/workflows/ios.yml@refs/heads/main",
        ),
        ("GITHUB_SHA", revision),
    ]
}

fn admit_ci_source(environment: &BTreeMap<String, String>, revision: &str) -> Result<()> {
    ensure!(
        revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "The distribution source must be a Git commit SHA"
    );
    for (name, expected) in source_requirements(revision) {
        ensure!(
            environment.get(name).map(String::as_str) == Some(expected),
            "Distribution requires the protected main-branch TestFlight workflow: {name} differs"
        );
    }
    Ok(())
}

pub(super) fn require_ci_source(root: &Path) -> Result<()> {
    let output = crate::checked(
        Command::new("git")
            .current_dir(root)
            .args(["rev-parse", "HEAD"]),
    )?;
    let revision = String::from_utf8(output.stdout)?;
    let revision = revision.trim();
    let environment = source_requirements(revision)
        .into_iter()
        .filter_map(|(name, _)| {
            std::env::var(name)
                .ok()
                .map(|value| (name.to_owned(), value))
        })
        .collect();
    admit_ci_source(&environment, revision)
}

pub(super) fn admit_request(signing: Signing, build: Option<BuildNumber>) -> Result<BuildNumber> {
    match signing {
        Signing::Local => Ok(build.unwrap_or(BuildNumber::LOCAL)),
        Signing::Ci => {
            let build = build.context("CI signing requires --build-number")?;
            ensure!(
                build.is_ci(),
                "CI build numbers come from `build-number` and exceed every local build"
            );
            Ok(build)
        }
    }
}

fn admit_secret(name: &str, value: &str) -> Result<()> {
    let value = value.trim();
    ensure!(!value.is_empty(), "{name} is empty");
    ensure!(
        !(value.starts_with("${") && value.ends_with('}')),
        "{name} holds an unresolved Doppler reference"
    );
    Ok(())
}

pub(super) fn secret(name: &str) -> Result<String> {
    let value = std::env::var(name).with_context(|| format!("Set {name}"))?;
    admit_secret(name, &value)?;
    Ok(value)
}

pub(super) fn decode_secret(name: &str, value: &str) -> Result<Vec<u8>> {
    admit_secret(name, value)?;
    let compact = value.split_ascii_whitespace().collect::<String>();
    STANDARD
        .decode(compact)
        .map_err(|_| anyhow!("{name} isn't standard base64"))
}

pub(super) fn decoded_secret(name: &str) -> Result<Vec<u8>> {
    decode_secret(name, &secret(name)?)
}

pub(super) fn scratch_directory(prefix: &str) -> Result<tempfile::TempDir> {
    let parent =
        std::env::var_os(RUNNER_TEMPORARY_DIRECTORY).map_or_else(std::env::temp_dir, PathBuf::from);
    Ok(tempfile::Builder::new().prefix(prefix).tempdir_in(parent)?)
}

pub(super) fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(PRIVATE_FILE_MODE)
        .open(path)
        .with_context(|| format!("Create private file {}", path.display()))?
        .write_all(bytes)?;
    Ok(())
}

fn team_identifier(value: &str) -> bool {
    value.len() == TEAM_IDENTIFIER_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

pub(super) fn uuid(value: &str) -> bool {
    value.len() == UUID_LENGTH
        && value.bytes().enumerate().all(|(index, byte)| {
            if UUID_SEPARATORS.contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Profile {
    pub uuid: String,
    pub team: String,
    pub application_identifier: String,
    pub app_groups: Vec<String>,
    pub get_task_allow: bool,
    pub device_scoped: bool,
}

pub(super) type Entries<'a, 'input> = BTreeMap<String, roxmltree::Node<'a, 'input>>;

pub(super) fn entries<'a, 'input>(
    dictionary: roxmltree::Node<'a, 'input>,
) -> Result<Entries<'a, 'input>> {
    ensure!(
        dictionary.has_tag_name("dict"),
        "Expected a property-list dictionary"
    );
    let mut children = dictionary.children().filter(roxmltree::Node::is_element);
    let mut values = BTreeMap::new();
    while let Some(key) = children.next() {
        ensure!(key.has_tag_name("key"), "Expected a property-list key");
        let value = children
            .next()
            .context("A property-list key has no value")?;
        let name = key.text().unwrap_or_default().to_owned();
        ensure!(
            values.insert(name, value).is_none(),
            "A property-list key repeats"
        );
    }
    Ok(values)
}

pub(super) fn text(node: roxmltree::Node<'_, '_>) -> Result<String> {
    ensure!(
        node.has_tag_name("string"),
        "Expected a property-list string"
    );
    Ok(node.text().unwrap_or_default().to_owned())
}

fn texts(node: roxmltree::Node<'_, '_>) -> Result<Vec<String>> {
    ensure!(node.has_tag_name("array"), "Expected a property-list array");
    node.children()
        .filter(roxmltree::Node::is_element)
        .map(text)
        .collect()
}

fn boolean(node: roxmltree::Node<'_, '_>) -> Result<bool> {
    match node.tag_name().name() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => bail!("Expected a property-list Boolean"),
    }
}

pub(super) fn parse_profile(xml: &str) -> Result<Profile> {
    let document = roxmltree::Document::parse_with_options(
        xml,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..roxmltree::ParsingOptions::default()
        },
    )?;
    let root = document.root_element();
    ensure!(
        root.has_tag_name("plist"),
        "The profile isn't a property list"
    );
    let top = entries(
        root.children()
            .find(roxmltree::Node::is_element)
            .context("The profile property list is empty")?,
    )?;
    let field = |name: &str| {
        top.get(name)
            .copied()
            .with_context(|| format!("The profile has no {name}"))
    };
    let uuid_value = text(field("UUID")?)?;
    ensure!(uuid(&uuid_value), "The profile UUID is malformed");
    let teams = texts(field("TeamIdentifier")?)?;
    let [team] = teams.as_slice() else {
        bail!("The profile must name exactly one team");
    };
    ensure!(team_identifier(team), "The profile team is malformed");
    let entitlements = entries(field("Entitlements")?)?;
    let application_identifier = text(
        entitlements
            .get("application-identifier")
            .copied()
            .context("The profile grants no application identifier")?,
    )?;
    let app_groups = entitlements
        .get("com.apple.security.application-groups")
        .copied()
        .map(texts)
        .transpose()?
        .unwrap_or_default();
    let get_task_allow = entitlements
        .get("get-task-allow")
        .copied()
        .map(boolean)
        .transpose()?
        .unwrap_or(false);
    Ok(Profile {
        uuid: uuid_value,
        team: team.clone(),
        application_identifier,
        app_groups,
        get_task_allow,
        device_scoped: top.contains_key("ProvisionedDevices")
            || top.contains_key("ProvisionsAllDevices"),
    })
}

pub(super) fn admit_profiles(app: &Profile, extension: &Profile, bundle: &str) -> Result<String> {
    ensure!(
        app.team == extension.team,
        "The app and extension profiles belong to different teams"
    );
    ensure!(
        app.uuid != extension.uuid,
        "The app and extension need separate profiles"
    );
    for (profile, identifier) in [
        (app, bundle.to_owned()),
        (extension, format!("{bundle}{EXTENSION_SUFFIX}")),
    ] {
        ensure!(
            profile.application_identifier == format!("{}.{identifier}", profile.team),
            "The profile for {identifier} grants another application identifier"
        );
        ensure!(
            !profile.device_scoped,
            "The profile for {identifier} is limited to devices; use an App Store profile"
        );
        ensure!(
            !profile.get_task_allow,
            "The profile for {identifier} allows debugging; use an App Store profile"
        );
        ensure!(
            profile.app_groups == [format!("group.{bundle}")],
            "The profile for {identifier} doesn't grant exactly the production App Group"
        );
    }
    Ok(app.team.clone())
}

fn admit_watch_profile(
    app: &Profile,
    extension: &Profile,
    watch: &Profile,
    bundle: &str,
) -> Result<()> {
    let team = admit_profiles(app, extension, bundle)?;
    ensure!(
        watch.team == team && watch.uuid != app.uuid && watch.uuid != extension.uuid,
        "The Watch profile must have its own identity in the same team"
    );
    ensure!(
        watch.application_identifier == format!("{team}.{bundle}.watchkitapp")
            && !watch.device_scoped
            && !watch.get_task_allow
            && watch.app_groups.is_empty(),
        "The Watch profile must grant the companion's App Store identity without an App Group"
    );
    Ok(())
}

pub(super) fn identity(listing: &str, team: &str) -> Result<String> {
    let identities = listing
        .lines()
        .filter_map(|line| {
            let (_, rest) = line.trim().split_once(") ")?;
            let (hash, name) = rest.split_once(' ')?;
            (hash.len() == SHA1_HEX_LENGTH && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .then(|| name.trim_matches('"').to_owned())
        })
        .collect::<Vec<_>>();
    let [name] = identities.as_slice() else {
        bail!(
            "The signing keychain must hold exactly one valid identity, found {}",
            identities.len()
        );
    };
    ensure!(
        name.starts_with(DISTRIBUTION_AUTHORITY) && name.ends_with(&format!("({team})")),
        "The signing identity isn't an Apple Distribution certificate of the profile team"
    );
    Ok(name.clone())
}

pub(super) fn search_list(listing: &str) -> Vec<String> {
    listing
        .lines()
        .map(|line| line.trim().trim_matches('"'))
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

fn admit_keychain_path(path: &Path) -> Result<()> {
    let display = path
        .to_str()
        .context("The signing keychain path isn't UTF-8")?;
    ensure!(
        path.is_absolute()
            && display.ends_with(KEYCHAIN_EXTENSION)
            && !display.chars().any(char::is_whitespace),
        "{KEYCHAIN} must be an absolute {KEYCHAIN_EXTENSION} path without spaces"
    );
    ensure!(
        !path.exists(),
        "{KEYCHAIN} already exists; delete the previous signing keychain first"
    );
    Ok(())
}

fn arguments(values: &[&std::ffi::OsStr]) -> Vec<OsString> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

pub(super) struct KeychainCommands<'a> {
    pub path: &'a Path,
    pub password: &'a str,
}

impl KeychainCommands<'_> {
    pub fn create(&self) -> Vec<OsString> {
        arguments(&[
            "create-keychain".as_ref(),
            "-p".as_ref(),
            self.password.as_ref(),
            self.path.as_ref(),
        ])
    }

    pub fn settings(&self) -> Vec<OsString> {
        arguments(&[
            "set-keychain-settings".as_ref(),
            "-lut".as_ref(),
            KEYCHAIN_LOCK_SECONDS.as_ref(),
            self.path.as_ref(),
        ])
    }

    pub fn unlock(&self) -> Vec<OsString> {
        arguments(&[
            "unlock-keychain".as_ref(),
            "-p".as_ref(),
            self.password.as_ref(),
            self.path.as_ref(),
        ])
    }

    pub fn import(&self, certificate: &Path, certificate_password: &str) -> Vec<OsString> {
        arguments(&[
            "import".as_ref(),
            certificate.as_ref(),
            "-k".as_ref(),
            self.path.as_ref(),
            "-f".as_ref(),
            "pkcs12".as_ref(),
            "-P".as_ref(),
            certificate_password.as_ref(),
            "-T".as_ref(),
            CODESIGN.as_ref(),
        ])
    }

    pub fn partitions(&self) -> Vec<OsString> {
        arguments(&[
            "set-key-partition-list".as_ref(),
            "-S".as_ref(),
            KEY_PARTITIONS.as_ref(),
            "-s".as_ref(),
            "-k".as_ref(),
            self.password.as_ref(),
            self.path.as_ref(),
        ])
    }
}

pub(super) fn identity_arguments(keychain: &Path) -> Vec<OsString> {
    arguments(&[
        "find-identity".as_ref(),
        "-v".as_ref(),
        "-p".as_ref(),
        "codesigning".as_ref(),
        keychain.as_ref(),
    ])
}

pub(super) fn search_list_arguments(keychains: &[OsString]) -> Vec<OsString> {
    let mut values = arguments(&[
        "list-keychains".as_ref(),
        "-d".as_ref(),
        "user".as_ref(),
        "-s".as_ref(),
    ]);
    values.extend(keychains.iter().cloned());
    values
}

fn security(values: &[OsString], purpose: &str) -> Result<Output> {
    let output = super::without_secrets(&mut Command::new(SECURITY))
        .args(values)
        .output()
        .with_context(|| format!("Start {purpose}"))?;
    ensure!(
        output.status.success(),
        "{purpose} failed with {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(output)
}

fn keychain_password() -> Result<String> {
    let mut bytes = [0; KEYCHAIN_PASSWORD_BYTES];
    fs::File::open(RANDOM_DEVICE)?.read_exact(&mut bytes)?;
    let mut password = String::with_capacity(KEYCHAIN_PASSWORD_BYTES * 2);
    for byte in bytes {
        write!(password, "{byte:02x}")?;
    }
    Ok(password)
}

struct Keychain {
    path: PathBuf,
    previous: Option<Vec<OsString>>,
}

impl Keychain {
    fn create(
        path: &Path,
        certificate: &[u8],
        certificate_password: &str,
        scratch: &Path,
    ) -> Result<Self> {
        admit_keychain_path(path)?;
        let password = keychain_password()?;
        let commands = KeychainCommands {
            path,
            password: &password,
        };
        security(&commands.create(), "signing keychain creation")?;
        let mut keychain = Self {
            path: path.to_owned(),
            previous: None,
        };
        security(&commands.settings(), "signing keychain settings")?;
        security(&commands.unlock(), "signing keychain unlock")?;
        let file = scratch.join("distribution.p12");
        write_private(&file, certificate)?;
        let imported = security(
            &commands.import(&file, certificate_password),
            "distribution certificate import",
        );
        fs::remove_file(&file)?;
        imported?;
        security(&commands.partitions(), "signing key access")?;
        let listing = security(
            &arguments(&["list-keychains".as_ref(), "-d".as_ref(), "user".as_ref()]),
            "keychain search list",
        )?;
        let previous = search_list(&String::from_utf8(listing.stdout)?)
            .into_iter()
            .filter(|entry| Path::new(entry) != path)
            .map(OsString::from)
            .collect::<Vec<_>>();
        let mut keychains = vec![path.as_os_str().to_owned()];
        keychains.extend(previous.iter().cloned());
        keychain.previous = Some(previous);
        security(
            &search_list_arguments(&keychains),
            "keychain search list update",
        )?;
        Ok(keychain)
    }

    fn identity(&self, team: &str) -> Result<String> {
        let listing = security(&identity_arguments(&self.path), "signing identity listing")?;
        identity(&String::from_utf8(listing.stdout)?, team)
    }
}

impl Drop for Keychain {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous
            && let Err(error) = security(
                &search_list_arguments(previous),
                "keychain search list restore",
            )
        {
            eprintln!("iOS check: {error:#}; the workflow's cleanup step deletes the keychain");
        }
        if let Err(error) = security(
            &arguments(&["delete-keychain".as_ref(), self.path.as_ref()]),
            "signing keychain deletion",
        ) {
            eprintln!("iOS check: {error:#}; the workflow's cleanup step deletes the keychain");
        }
    }
}

struct InstalledProfiles(Vec<PathBuf>);

impl InstalledProfiles {
    fn install<const N: usize>(directory: &Path, profiles: [(&Profile, &[u8]); N]) -> Result<Self> {
        fs::create_dir_all(directory)?;
        let mut installed = Self(Vec::new());
        for (profile, bytes) in profiles {
            let path = directory.join(format!("{}.mobileprovision", profile.uuid));
            write_private(&path, bytes)?;
            installed.0.push(path);
        }
        Ok(installed)
    }
}

impl Drop for InstalledProfiles {
    fn drop(&mut self) {
        for path in &self.0 {
            if let Err(error) = fs::remove_file(path) {
                eprintln!(
                    "iOS check: installed profile {} wasn't removed: {error}",
                    path.display()
                );
            }
        }
    }
}

fn decode_profile(bytes: &[u8], scratch: &Path, name: &str) -> Result<Profile> {
    let file = scratch.join(format!("{name}.mobileprovision"));
    write_private(&file, bytes)?;
    let decoded = security(
        &arguments(&["cms".as_ref(), "-D".as_ref(), "-i".as_ref(), file.as_ref()]),
        "provisioning profile decoding",
    );
    fs::remove_file(&file)?;
    parse_profile(&String::from_utf8(decoded?.stdout)?)
        .with_context(|| format!("The {name} provisioning profile is invalid"))
}

#[derive(Clone, Copy)]
enum ProfileRead {
    App,
    Extension,
    Watch,
    BeforeWatchRegistration,
}

impl ProfileRead {
    fn name(self) -> &'static str {
        match self {
            Self::App => APP_PROFILE,
            Self::Extension => EXTENSION_PROFILE,
            Self::Watch | Self::BeforeWatchRegistration => WATCH_PROFILE,
        }
    }

    fn command(self) -> Command {
        let mut command = Command::new("doppler");
        command.args([
            "secrets",
            "get",
            self.name(),
            "--plain",
            "--project",
            "public-phonebook",
            "--config",
            "ci_testflight_signing",
            "--no-read-env",
        ]);
        if matches!(self, Self::BeforeWatchRegistration) {
            command.arg("--no-exit-on-missing-secret");
        }
        command
    }
}

fn doppler_value(read: ProfileRead) -> Result<String> {
    let name = read.name();
    let output = read
        .command()
        .output()
        .context("Read the selected signing profile from Doppler")?;
    ensure!(output.status.success(), "Doppler couldn't read {name}");
    String::from_utf8(output.stdout).context("The signing profile isn't UTF-8")
}

struct ProfileMaterial {
    certificates: Vec<Vec<u8>>,
    expires: u64,
}

fn profile_material(bytes: &[u8], scratch: &Path, name: &str) -> Result<ProfileMaterial> {
    let file = scratch.join(format!("{name}-certificates.mobileprovision"));
    write_private(&file, bytes)?;
    let decoded = security(
        &arguments(&["cms".as_ref(), "-D".as_ref(), "-i".as_ref(), file.as_ref()]),
        "profile certificate verification",
    );
    fs::remove_file(file)?;
    let xml = String::from_utf8(decoded?.stdout)?;
    let document = roxmltree::Document::parse_with_options(
        &xml,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        },
    )?;
    let top = entries(
        document
            .root_element()
            .children()
            .find(roxmltree::Node::is_element)
            .context("The profile is empty")?,
    )?;
    let expiration = top
        .get("ExpirationDate")
        .context("The profile has no expiration")?;
    ensure!(
        expiration.has_tag_name("date"),
        "The profile expiration isn't a date"
    );
    let output = Command::new("/bin/date")
        .args([
            "-u",
            "-j",
            "-f",
            "%Y-%m-%dT%H:%M:%SZ",
            expiration.text().unwrap_or_default(),
            "+%s",
        ])
        .output()?;
    ensure!(output.status.success(), "The profile expiration is invalid");
    let expires = String::from_utf8(output.stdout)?.trim().parse::<u64>()?;
    let certificates = top
        .get("DeveloperCertificates")
        .context("The profile has no certificate")?;
    ensure!(
        certificates.has_tag_name("array"),
        "The profile certificates aren't an array"
    );
    let certificates = certificates
        .children()
        .filter(roxmltree::Node::is_element)
        .map(|node| {
            ensure!(
                node.has_tag_name("data"),
                "The profile certificate isn't data"
            );
            decode_secret("Profile certificate", node.text().unwrap_or_default())
        })
        .collect::<Result<_>>()?;
    Ok(ProfileMaterial {
        certificates,
        expires,
    })
}

fn admit_profile_material(
    app: &ProfileMaterial,
    watch: &ProfileMaterial,
    now: u64,
    current: &str,
    proposed: &str,
) -> Result<()> {
    ensure!(
        !watch.certificates.is_empty() && watch.certificates == app.certificates,
        "The Watch profile doesn't use the existing app profile's distribution certificate"
    );
    ensure!(
        watch.expires > now && app.expires > now,
        "The provisioning profile has expired"
    );
    ensure!(
        current.trim().is_empty() || current.trim() == proposed,
        "Doppler already holds a different Watch profile"
    );
    Ok(())
}

pub(super) fn import_watch_profile(path: &Path) -> Result<()> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(262_145)
        .read_to_end(&mut bytes)?;
    ensure!(
        !bytes.is_empty() && bytes.len() <= 262_144,
        "The profile must fit within 256 KiB"
    );
    let scratch = scratch_directory("watch-profile-import-")?;
    let app_bytes = decode_secret(APP_PROFILE, &doppler_value(ProfileRead::App)?)?;
    let extension_bytes =
        decode_secret(EXTENSION_PROFILE, &doppler_value(ProfileRead::Extension)?)?;
    let current = doppler_value(ProfileRead::BeforeWatchRegistration)?;
    let app = decode_profile(&app_bytes, scratch.path(), "app")?;
    let extension = decode_profile(&extension_bytes, scratch.path(), "extension")?;
    let watch = decode_profile(&bytes, scratch.path(), "watch")?;
    admit_watch_profile(&app, &extension, &watch, "page.dial.publicphonebook")?;
    let app_material = profile_material(&app_bytes, scratch.path(), "app")?;
    let watch_material = profile_material(&bytes, scratch.path(), "watch")?;
    let encoded = STANDARD.encode(bytes);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    admit_profile_material(&app_material, &watch_material, now, &current, &encoded)?;
    if current.trim().is_empty() {
        let mut child = Command::new("doppler")
            .args([
                "secrets",
                "set",
                WATCH_PROFILE,
                "--project",
                "public-phonebook",
                "--config",
                "ci_testflight_signing",
                "--silent",
                "--no-interactive",
                "--no-read-env",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        child
            .stdin
            .take()
            .context("Doppler has no input pipe")?
            .write_all(encoded.as_bytes())?;
        ensure!(
            child.wait()?.success(),
            "Doppler couldn't save the Watch profile"
        );
    }
    ensure!(
        doppler_value(ProfileRead::Watch)?.trim() == encoded,
        "The saved Watch profile doesn't match the admitted profile"
    );
    println!("PASS: matching Watch App Store profile registered in ci_testflight_signing");
    Ok(())
}

pub(super) struct ManualSigning {
    pub team: String,
    pub identity: String,
    pub keychain: PathBuf,
    pub app_profile: String,
    pub extension_profile: String,
    pub watch_profile: String,
}

pub(super) fn archive_settings(signing: Option<&ManualSigning>, build: BuildNumber) -> Vec<String> {
    let mut settings = vec![format!("CURRENT_PROJECT_VERSION={build}")];
    if let Some(signing) = signing {
        settings.extend([
            "CODE_SIGN_STYLE=Manual".to_owned(),
            format!("DEVELOPMENT_TEAM={}", signing.team),
            format!("CODE_SIGN_IDENTITY={}", signing.identity),
            format!(
                "OTHER_CODE_SIGN_FLAGS=--keychain {}",
                signing.keychain.display()
            ),
            format!("PHONEBOOK_APP_PROFILE={}", signing.app_profile),
            format!(
                "PHONEBOOK_CALL_DIRECTORY_PROFILE={}",
                signing.extension_profile
            ),
            format!("PHONEBOOK_WATCH_PROFILE={}", signing.watch_profile),
        ]);
    }
    settings
}

fn xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub(super) fn export_options(signing: Option<&ManualSigning>, bundle: &str) -> String {
    let mut entries = String::from(
        "<key>method</key><string>app-store-connect</string><key>destination</key><string>export</string>",
    );
    match signing {
        None => entries.push_str("<key>signingStyle</key><string>automatic</string>"),
        Some(signing) => {
            entries.push_str("<key>signingStyle</key><string>manual</string>");
            entries.push_str(&format!(
                "<key>teamID</key><string>{}</string><key>signingCertificate</key><string>{}</string><key>provisioningProfiles</key><dict><key>{}</key><string>{}</string><key>{}</key><string>{}</string><key>{}</key><string>{}</string></dict>",
                xml_text(&signing.team),
                xml_text(&signing.identity),
                xml_text(bundle),
                xml_text(&signing.app_profile),
                xml_text(&format!("{bundle}{EXTENSION_SUFFIX}")),
                xml_text(&signing.extension_profile),
                xml_text(&format!("{bundle}.watchkitapp")),
                xml_text(&signing.watch_profile),
            ));
        }
    }
    entries.push_str(
        "<key>manageAppVersionAndBuildNumber</key><false/><key>uploadSymbols</key><true/>",
    );
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>{PROPERTY_LIST_DOCUMENT_TYPE}<plist version=\"1.0\"><dict>{entries}</dict></plist>"
    )
}

pub(super) struct CiSigning {
    pub manual: ManualSigning,
    _profiles: InstalledProfiles,
    _keychain: Keychain,
    _scratch: tempfile::TempDir,
}

pub(super) fn prepare(bundle: &str) -> Result<CiSigning> {
    let keychain_path = PathBuf::from(secret(KEYCHAIN)?);
    let app_bytes = decoded_secret(APP_PROFILE)?;
    let extension_bytes = decoded_secret(EXTENSION_PROFILE)?;
    let watch_bytes = decoded_secret(WATCH_PROFILE)?;
    let certificate = decoded_secret(CERTIFICATE)?;
    let certificate_password = secret(CERTIFICATE_PASSWORD)?;
    let scratch = scratch_directory("signing-")?;
    let app = decode_profile(&app_bytes, scratch.path(), "app")?;
    let extension = decode_profile(&extension_bytes, scratch.path(), "extension")?;
    let watch = decode_profile(&watch_bytes, scratch.path(), "watch")?;
    let team = admit_profiles(&app, &extension, bundle)?;
    admit_watch_profile(&app, &extension, &watch, bundle)?;
    let keychain = Keychain::create(
        &keychain_path,
        &certificate,
        &certificate_password,
        scratch.path(),
    )?;
    let identity = keychain.identity(&team)?;
    let home = std::env::var_os("HOME").context("Set HOME")?;
    let profiles = InstalledProfiles::install(
        &Path::new(&home).join(PROVISIONING_PROFILES),
        [
            (&app, &app_bytes),
            (&extension, &extension_bytes),
            (&watch, &watch_bytes),
        ],
    )?;
    println!("iOS check: temporary signing keychain and three App Store profiles installed");
    Ok(CiSigning {
        manual: ManualSigning {
            team,
            identity,
            keychain: keychain_path,
            app_profile: app.uuid,
            extension_profile: extension.uuid,
            watch_profile: watch.uuid,
        },
        _profiles: profiles,
        _keychain: keychain,
        _scratch: scratch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLE: &str = "page.dial.publicphonebook";
    const TEAM: &str = "ABCDE12345";
    const APP_UUID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const EXTENSION_UUID: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    fn profile_xml(uuid: &str, identifier: &str, extra: &str) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n{PROPERTY_LIST_DOCUMENT_TYPE}\n<plist version=\"1.0\"><dict><key>AppIDName</key><string>Public Phonebook</string><key>CreationDate</key><date>2026-11-01T00:00:00Z</date><key>DeveloperCertificates</key><array><data>AAEC</data></array><key>Entitlements</key><dict><key>application-identifier</key><string>{TEAM}.{identifier}</string><key>com.apple.security.application-groups</key><array><string>group.{BUNDLE}</string></array><key>get-task-allow</key><false/><key>com.apple.developer.team-identifier</key><string>{TEAM}</string></dict><key>ExpirationDate</key><date>2027-11-01T00:00:00Z</date><key>Name</key><string>App Store {identifier}</string>{extra}<key>TeamIdentifier</key><array><string>{TEAM}</string></array><key>UUID</key><string>{uuid}</string></dict></plist>\n"
        )
    }

    fn profiles() -> Result<(Profile, Profile)> {
        Ok((
            parse_profile(&profile_xml(APP_UUID, BUNDLE, ""))?,
            parse_profile(&profile_xml(
                EXTENSION_UUID,
                &format!("{BUNDLE}{EXTENSION_SUFFIX}"),
                "",
            ))?,
        ))
    }

    #[test]
    fn imported_watch_profile_requires_the_current_certificate_and_an_empty_or_identical_destination()
    -> Result<()> {
        let app = ProfileMaterial {
            certificates: vec![vec![1, 2]],
            expires: 20,
        };
        admit_profile_material(&app, &app, 10, "", "encoded")?;
        admit_profile_material(&app, &app, 10, "encoded\n", "encoded")?;
        for (certificates, expires, current) in [
            (vec![vec![3]], 20, ""),
            (vec![], 20, ""),
            (vec![vec![1, 2]], 10, ""),
            (vec![vec![1, 2]], 20, "another profile"),
        ] {
            assert!(
                admit_profile_material(
                    &app,
                    &ProfileMaterial {
                        certificates,
                        expires
                    },
                    10,
                    current,
                    "encoded"
                )
                .is_err()
            );
        }
        Ok(())
    }

    #[test]
    fn watch_profile_requires_its_own_store_identity_without_shared_data() -> Result<()> {
        let (app, extension) = profiles()?;
        let watch = || Profile {
            uuid: "12345678-1234-1234-1234-123456789012".to_owned(),
            team: TEAM.to_owned(),
            application_identifier: format!("{TEAM}.{BUNDLE}.watchkitapp"),
            app_groups: Vec::new(),
            get_task_allow: false,
            device_scoped: false,
        };
        admit_watch_profile(&app, &extension, &watch(), BUNDLE)?;
        let mut changed = watch();
        changed.uuid = app.uuid.clone();
        assert!(admit_watch_profile(&app, &extension, &changed, BUNDLE).is_err());
        let mut changed = watch();
        changed.team = "ZZZZZ99999".to_owned();
        assert!(admit_watch_profile(&app, &extension, &changed, BUNDLE).is_err());
        let mut changed = watch();
        changed.application_identifier = format!("{TEAM}.{BUNDLE}");
        assert!(admit_watch_profile(&app, &extension, &changed, BUNDLE).is_err());
        let mut changed = watch();
        changed.get_task_allow = true;
        assert!(admit_watch_profile(&app, &extension, &changed, BUNDLE).is_err());
        let mut changed = watch();
        changed.device_scoped = true;
        assert!(admit_watch_profile(&app, &extension, &changed, BUNDLE).is_err());
        let mut changed = watch();
        changed.app_groups = app.app_groups.clone();
        assert!(admit_watch_profile(&app, &extension, &changed, BUNDLE).is_err());
        Ok(())
    }

    #[test]
    fn app_store_profiles_for_both_targets_are_admitted() -> Result<()> {
        let (app, extension) = profiles()?;
        assert_eq!(
            app,
            Profile {
                uuid: APP_UUID.to_owned(),
                team: TEAM.to_owned(),
                application_identifier: format!("{TEAM}.{BUNDLE}"),
                app_groups: vec![format!("group.{BUNDLE}")],
                get_task_allow: false,
                device_scoped: false,
            }
        );
        assert_eq!(admit_profiles(&app, &extension, BUNDLE)?, TEAM);
        Ok(())
    }

    #[test]
    fn development_ad_hoc_swapped_and_foreign_profiles_are_refused() -> Result<()> {
        let (app, extension) = profiles()?;
        assert!(admit_profiles(&extension, &app, BUNDLE).is_err());
        assert!(admit_profiles(&app, &app, BUNDLE).is_err());
        let ad_hoc = parse_profile(&profile_xml(
            APP_UUID,
            BUNDLE,
            "<key>ProvisionedDevices</key><array><string>00008140-000000000000001E</string></array>",
        ))?;
        assert!(admit_profiles(&ad_hoc, &extension, BUNDLE).is_err());
        let enterprise = parse_profile(&profile_xml(
            APP_UUID,
            BUNDLE,
            "<key>ProvisionsAllDevices</key><true/>",
        ))?;
        assert!(admit_profiles(&enterprise, &extension, BUNDLE).is_err());
        let debuggable = parse_profile(&profile_xml(APP_UUID, BUNDLE, "").replace(
            "<key>get-task-allow</key><false/>",
            "<key>get-task-allow</key><true/>",
        ))?;
        assert!(admit_profiles(&debuggable, &extension, BUNDLE).is_err());
        let ungrouped = parse_profile(&profile_xml(APP_UUID, BUNDLE, "").replace(
            &format!("<string>group.{BUNDLE}</string>"),
            "<string>group.page.dial.publicphonebook.development</string>",
        ))?;
        assert!(admit_profiles(&ungrouped, &extension, BUNDLE).is_err());
        let foreign = Profile {
            team: "ZYXWV98765".to_owned(),
            application_identifier: format!("ZYXWV98765.{BUNDLE}"),
            ..parse_profile(&profile_xml(APP_UUID, BUNDLE, ""))?
        };
        assert!(admit_profiles(&foreign, &extension, BUNDLE).is_err());
        let development =
            parse_profile(&profile_xml(APP_UUID, &format!("{BUNDLE}.development"), ""))?;
        assert!(admit_profiles(&development, &extension, BUNDLE).is_err());
        Ok(())
    }

    #[test]
    fn malformed_profiles_are_refused() {
        let valid = profile_xml(APP_UUID, BUNDLE, "");
        for invalid in [
            valid.replace(APP_UUID, "../../escape"),
            valid.replace(
                &format!("<array><string>{TEAM}</string></array>"),
                &format!("<array><string>{TEAM}</string><string>{TEAM}</string></array>"),
            ),
            valid.replace(
                &format!("<array><string>{TEAM}</string></array>"),
                "<array><string>team</string></array>",
            ),
            valid.replace("<key>UUID</key>", "<key>Identifier</key>"),
            valid.replace("<key>application-identifier</key>", "<key>identifier</key>"),
            valid.replace(
                "<key>get-task-allow</key><false/>",
                "<key>get-task-allow</key><string>no</string>",
            ),
            valid.replace(
                "<key>Name</key>",
                &format!("<key>UUID</key><string>{EXTENSION_UUID}</string><key>Name</key>"),
            ),
            valid
                .replace("<plist version=\"1.0\">", "<array>")
                .replace("</plist>", "</array>"),
            "not a property list".to_owned(),
        ] {
            assert!(parse_profile(&invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn the_signing_identity_must_be_the_only_team_distribution_certificate() -> Result<()> {
        let one = format!(
            "  1) 0123456789ABCDEF0123456789ABCDEF01234567 \"Apple Distribution: Example Owner ({TEAM})\"\n     1 valid identities found\n"
        );
        assert_eq!(
            identity(&one, TEAM)?,
            format!("Apple Distribution: Example Owner ({TEAM})")
        );
        for invalid in [
            "     0 valid identities found\n".to_owned(),
            one.replace("Apple Distribution", "Apple Development"),
            one.replace(TEAM, "ZYXWV98765"),
            format!(
                "{}  2) FEDCBA9876543210FEDCBA9876543210FEDCBA98 \"Apple Distribution: Other ({TEAM})\"\n",
                one
            ),
        ] {
            assert!(identity(&invalid, TEAM).is_err(), "{invalid}");
        }
        Ok(())
    }

    #[test]
    fn keychain_commands_import_only_for_codesign_and_restore_the_search_list() {
        let path = Path::new("/runner/temp/testflight-signing.keychain-db");
        let commands = KeychainCommands {
            path,
            password: "keychain-password",
        };
        let rendered = |values: Vec<OsString>| {
            values
                .into_iter()
                .map(|value| value.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            rendered(commands.create()),
            [
                "create-keychain",
                "-p",
                "keychain-password",
                "/runner/temp/testflight-signing.keychain-db"
            ]
        );
        assert_eq!(
            rendered(commands.settings()),
            [
                "set-keychain-settings",
                "-lut",
                "21600",
                "/runner/temp/testflight-signing.keychain-db"
            ]
        );
        assert_eq!(
            rendered(commands.import(
                Path::new("/scratch/distribution.p12"),
                "certificate-password"
            )),
            [
                "import",
                "/scratch/distribution.p12",
                "-k",
                "/runner/temp/testflight-signing.keychain-db",
                "-f",
                "pkcs12",
                "-P",
                "certificate-password",
                "-T",
                CODESIGN
            ]
        );
        assert_eq!(
            rendered(commands.partitions()),
            [
                "set-key-partition-list",
                "-S",
                KEY_PARTITIONS,
                "-s",
                "-k",
                "keychain-password",
                "/runner/temp/testflight-signing.keychain-db"
            ]
        );
        let listing = "    \"/Users/runner/Library/Keychains/login.keychain-db\"\n    \"/Library/Keychains/System.keychain\"\n";
        let previous = search_list(listing);
        assert_eq!(
            previous,
            [
                "/Users/runner/Library/Keychains/login.keychain-db",
                "/Library/Keychains/System.keychain"
            ]
        );
        let mut keychains = vec![OsString::from(path)];
        keychains.extend(previous.iter().map(OsString::from));
        assert_eq!(
            rendered(search_list_arguments(&keychains)),
            [
                "list-keychains",
                "-d",
                "user",
                "-s",
                "/runner/temp/testflight-signing.keychain-db",
                "/Users/runner/Library/Keychains/login.keychain-db",
                "/Library/Keychains/System.keychain"
            ]
        );
    }

    #[test]
    fn keychain_paths_must_be_new_absolute_keychain_files() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let fresh = directory.path().join("signing.keychain-db");
        admit_keychain_path(&fresh)?;
        fs::write(&fresh, "")?;
        assert!(admit_keychain_path(&fresh).is_err());
        for invalid in [
            PathBuf::from("signing.keychain-db"),
            directory.path().join("signing.keychain"),
            directory.path().join("signing key.keychain-db"),
        ] {
            assert!(
                admit_keychain_path(&invalid).is_err(),
                "{}",
                invalid.display()
            );
        }
        Ok(())
    }

    #[test]
    fn manual_archive_settings_pin_the_profiles_identity_keychain_and_build() -> Result<()> {
        let build = BuildNumber::from_run(42, 3)?;
        assert_eq!(
            archive_settings(None, build),
            ["CURRENT_PROJECT_VERSION=4201"]
        );
        let signing = ManualSigning {
            team: TEAM.to_owned(),
            identity: format!("Apple Distribution: Example & Owner ({TEAM})"),
            keychain: PathBuf::from("/runner/temp/testflight-signing.keychain-db"),
            app_profile: APP_UUID.to_owned(),
            extension_profile: EXTENSION_UUID.to_owned(),
            watch_profile: "12345678-1234-1234-1234-123456789012".to_owned(),
        };
        assert_eq!(
            archive_settings(Some(&signing), build),
            [
                "CURRENT_PROJECT_VERSION=4201".to_owned(),
                "CODE_SIGN_STYLE=Manual".to_owned(),
                format!("DEVELOPMENT_TEAM={TEAM}"),
                format!("CODE_SIGN_IDENTITY=Apple Distribution: Example & Owner ({TEAM})"),
                "OTHER_CODE_SIGN_FLAGS=--keychain /runner/temp/testflight-signing.keychain-db"
                    .to_owned(),
                format!("PHONEBOOK_APP_PROFILE={APP_UUID}"),
                format!("PHONEBOOK_CALL_DIRECTORY_PROFILE={EXTENSION_UUID}"),
                "PHONEBOOK_WATCH_PROFILE=12345678-1234-1234-1234-123456789012".to_owned(),
            ]
        );
        let options = export_options(Some(&signing), BUNDLE);
        let document = roxmltree::Document::parse_with_options(
            &options,
            roxmltree::ParsingOptions {
                allow_dtd: true,
                ..roxmltree::ParsingOptions::default()
            },
        )?;
        let top = entries(
            document
                .root_element()
                .first_element_child()
                .context("Export options are empty")?,
        )?;
        let value = |key: &str| -> Result<String> {
            text(
                top.get(key)
                    .copied()
                    .with_context(|| format!("Missing {key}"))?,
            )
        };
        assert_eq!(value("method")?, "app-store-connect");
        assert_eq!(value("destination")?, "export");
        assert_eq!(value("signingStyle")?, "manual");
        assert_eq!(value("teamID")?, TEAM);
        assert_eq!(
            value("signingCertificate")?,
            format!("Apple Distribution: Example & Owner ({TEAM})")
        );
        let profiles = entries(
            top.get("provisioningProfiles")
                .copied()
                .context("Missing profiles")?,
        )?;
        assert_eq!(profiles.len(), 3);
        assert_eq!(text(profiles[BUNDLE])?, APP_UUID);
        assert_eq!(
            text(profiles[&format!("{BUNDLE}{EXTENSION_SUFFIX}")])?,
            EXTENSION_UUID
        );
        assert_eq!(
            text(profiles[&format!("{BUNDLE}.watchkitapp")])?,
            signing.watch_profile
        );
        assert!(!boolean(top["manageAppVersionAndBuildNumber"])?);
        assert!(boolean(top["uploadSymbols"])?);
        let automatic = export_options(None, BUNDLE);
        assert!(automatic.contains("<key>signingStyle</key><string>automatic</string>"));
        assert!(!automatic.contains("provisioningProfiles"));
        Ok(())
    }

    #[test]
    fn ci_source_requires_the_dispatched_main_workflow_at_the_checked_revision() -> Result<()> {
        let revision = "a".repeat(40);
        let environment = BTreeMap::from([
            ("GITHUB_ACTIONS".to_owned(), "true".to_owned()),
            (
                "GITHUB_EVENT_NAME".to_owned(),
                "workflow_dispatch".to_owned(),
            ),
            (
                "GITHUB_REPOSITORY".to_owned(),
                "P4suta/public-phonebook".to_owned(),
            ),
            ("GITHUB_REF".to_owned(), "refs/heads/main".to_owned()),
            (
                "GITHUB_WORKFLOW_REF".to_owned(),
                "P4suta/public-phonebook/.github/workflows/ios.yml@refs/heads/main".to_owned(),
            ),
            ("GITHUB_SHA".to_owned(), revision.clone()),
        ]);
        admit_ci_source(&environment, &revision)?;
        for name in environment.keys() {
            let mut missing = environment.clone();
            missing.remove(name);
            assert!(
                admit_ci_source(&missing, &revision).is_err(),
                "missing {name}"
            );
            let mut changed = environment.clone();
            changed.insert(name.clone(), "another source".to_owned());
            assert!(
                admit_ci_source(&changed, &revision).is_err(),
                "changed {name}"
            );
        }
        assert!(admit_ci_source(&environment, &"b".repeat(40)).is_err());
        Ok(())
    }

    #[test]
    fn ci_requests_require_a_run_derived_build() -> Result<()> {
        let ci = BuildNumber::from_run(7, 1)?;
        assert_eq!(admit_request(Signing::Ci, Some(ci))?, ci);
        assert!(admit_request(Signing::Ci, None).is_err());
        assert!(admit_request(Signing::Ci, Some(BuildNumber::LOCAL)).is_err());
        assert_eq!(admit_request(Signing::Local, None)?, BuildNumber::LOCAL);
        assert_eq!(admit_request(Signing::Local, Some(ci))?, ci);
        Ok(())
    }

    #[test]
    fn secrets_must_be_present_resolved_and_base64() -> Result<()> {
        assert_eq!(decode_secret("VALUE", "AAEC\n/w==\n")?, [0, 1, 2, 255]);
        assert!(decode_secret("VALUE", "").is_err());
        assert!(decode_secret("VALUE", "  \n").is_err());
        for invalid in ["${public-phonebook.ci_testflight.VALUE}", "not base64!"] {
            let error = decode_secret("VALUE", invalid)
                .err()
                .context("An invalid secret was admitted")?;
            assert!(!format!("{error:#}").contains(invalid), "{error:#}");
        }
        Ok(())
    }

    #[test]
    fn only_the_initial_watch_profile_read_permits_an_absent_secret() {
        for (read, name, optional) in [
            (ProfileRead::App, APP_PROFILE, false),
            (ProfileRead::Extension, EXTENSION_PROFILE, false),
            (ProfileRead::Watch, WATCH_PROFILE, false),
            (ProfileRead::BeforeWatchRegistration, WATCH_PROFILE, true),
        ] {
            let command = read.command();
            let arguments: Vec<_> = command.get_args().collect();
            assert_eq!(arguments[0], "secrets");
            assert_eq!(arguments[1], "get");
            assert_eq!(arguments[2], name);
            assert!(arguments.contains(&"--plain".as_ref()));
            assert!(arguments.contains(&"--no-read-env".as_ref()));
            assert_eq!(
                arguments.contains(&"--no-exit-on-missing-secret".as_ref()),
                optional,
                "{name}",
            );
        }
    }

    #[test]
    fn private_files_are_owner_only_and_never_replace_existing_files() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        const PERMISSION_BITS: u32 = 0o777;
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("key.p8");
        write_private(&path, b"secret")?;
        assert_eq!(
            fs::metadata(&path)?.permissions().mode() & PERMISSION_BITS,
            PRIVATE_FILE_MODE
        );
        assert!(write_private(&path, b"other").is_err());
        assert_eq!(fs::read(&path)?, b"secret");
        Ok(())
    }

    #[test]
    fn export_text_escapes_markup() {
        assert_eq!(
            xml_text("A&B <C> \"D\" 'E'"),
            "A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;"
        );
    }
}
