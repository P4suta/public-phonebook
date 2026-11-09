use anyhow::{Result, ensure};
use clap::ValueEnum;
use delivery_core::{Change, Checks, Targets};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::fmt;

pub const REPOSITORY: &str = "P4suta/public-phonebook";
pub const GITHUB_ORIGIN: &str = "https://github.com";
pub const PLAN_FORMAT: u32 = 1;
const REVISION_BYTES: usize = 40;
const DIGEST_BYTES: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Revision(String);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Digest(String);

fn hexadecimal(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl TryFrom<String> for Revision {
    type Error = anyhow::Error;
    fn try_from(value: String) -> Result<Self> {
        ensure!(
            hexadecimal(&value, REVISION_BYTES),
            "A source revision must be a complete lowercase Git commit identifier"
        );
        Ok(Self(value))
    }
}

impl From<Revision> for String {
    fn from(value: Revision) -> Self {
        value.0
    }
}
impl fmt::Display for Revision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}
impl Revision {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Digest {
    type Error = anyhow::Error;
    fn try_from(value: String) -> Result<Self> {
        ensure!(
            hexadecimal(&value, DIGEST_BYTES),
            "A digest must contain 64 lowercase hexadecimal characters"
        );
        Ok(Self(value))
    }
}

impl From<Digest> for String {
    fn from(value: Digest) -> Self {
        value.0
    }
}
impl fmt::Display for Digest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}
impl Digest {
    pub fn of(bytes: &[u8]) -> Self {
        Self(
            Sha256::digest(bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        )
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Target {
    Worker,
    Ios,
    Android,
    CloudflareAlerts,
    Monitors,
}

impl Target {
    pub const ALL: [Self; 5] = [
        Self::Worker,
        Self::Ios,
        Self::Android,
        Self::CloudflareAlerts,
        Self::Monitors,
    ];
    pub const fn mask(self) -> Targets {
        match self {
            Self::Worker => Targets::WORKER,
            Self::Ios => Targets::IOS,
            Self::Android => Targets::ANDROID,
            Self::CloudflareAlerts => Targets::CLOUDFLARE_ALERTS,
            Self::Monitors => Targets::MONITORS,
        }
    }
    pub const fn name(self) -> &'static str {
        match self {
            Self::Worker => "worker",
            Self::Ios => "ios",
            Self::Android => "android",
            Self::CloudflareAlerts => "cloudflare-alerts",
            Self::Monitors => "monitors",
        }
    }
    pub fn members(targets: Targets) -> Vec<Self> {
        Self::ALL
            .into_iter()
            .filter(|target| targets.contains(target.mask()))
            .collect()
    }
    pub fn combine(targets: &[Self]) -> Targets {
        targets.iter().fold(Targets::NONE, |selected, target| {
            selected.union(target.mask())
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Check {
    Fast,
    Worker,
    Ios,
    Android,
    Compatibility,
    Operations,
}

impl Check {
    pub const ALL: [Self; 6] = [
        Self::Fast,
        Self::Worker,
        Self::Ios,
        Self::Android,
        Self::Compatibility,
        Self::Operations,
    ];
    pub const fn mask(self) -> Checks {
        match self {
            Self::Fast => Checks::FAST,
            Self::Worker => Checks::WORKER,
            Self::Ios => Checks::IOS,
            Self::Android => Checks::ANDROID,
            Self::Compatibility => Checks::COMPATIBILITY,
            Self::Operations => Checks::OPERATIONS,
        }
    }
    pub fn members(checks: Checks) -> Vec<Self> {
        Self::ALL
            .into_iter()
            .filter(|check| checks.contains(check.mask()))
            .collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    Worker,
    IosTestflight,
    AndroidArtifacts,
    CloudflareAlertsPreview,
    CloudflareAlertsApply,
    MonitorsPreview,
    MonitorsApply,
    VersionIos,
    VersionAndroid,
}

impl Operation {
    pub const fn prepares_version(self) -> bool {
        matches!(self, Self::VersionIos | Self::VersionAndroid)
    }

    pub fn gate_requirements(self, worker: bool, ios: bool, android: bool) -> [bool; 6] {
        let artifacts = !self.prepares_version();
        [
            true,
            true,
            artifacts,
            artifacts && worker && self != Self::Worker,
            artifacts && ios && self != Self::IosTestflight && self != Self::Worker,
            artifacts && android && self != Self::AndroidArtifacts,
        ]
    }
    pub const fn workflow(self) -> &'static str {
        match self {
            Self::Worker => "release.yml",
            Self::IosTestflight => "ios.yml",
            Self::AndroidArtifacts => "android.yml",
            Self::CloudflareAlertsPreview
            | Self::CloudflareAlertsApply
            | Self::MonitorsPreview
            | Self::MonitorsApply => "operations.yml",
            Self::VersionIos | Self::VersionAndroid => "versions.yml",
        }
    }
    pub const fn target(self) -> Target {
        match self {
            Self::Worker => Target::Worker,
            Self::IosTestflight | Self::VersionIos => Target::Ios,
            Self::AndroidArtifacts | Self::VersionAndroid => Target::Android,
            Self::CloudflareAlertsPreview | Self::CloudflareAlertsApply => Target::CloudflareAlerts,
            Self::MonitorsPreview | Self::MonitorsApply => Target::Monitors,
        }
    }
    pub const fn name(self) -> &'static str {
        match self {
            Self::Worker => "worker",
            Self::IosTestflight => "ios-testflight",
            Self::AndroidArtifacts => "android-artifacts",
            Self::CloudflareAlertsPreview => "cloudflare-alerts-preview",
            Self::CloudflareAlertsApply => "cloudflare-alerts-apply",
            Self::MonitorsPreview => "monitors-preview",
            Self::MonitorsApply => "monitors-apply",
            Self::VersionIos => "version-ios",
            Self::VersionAndroid => "version-android",
        }
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum JobResult {
    Success,
    Failure,
    Cancelled,
    Skipped,
}
impl JobResult {
    pub const fn outcome(self) -> delivery_core::JobOutcome {
        match self {
            Self::Success => delivery_core::JobOutcome::Success,
            Self::Failure => delivery_core::JobOutcome::Failure,
            Self::Cancelled => delivery_core::JobOutcome::Cancelled,
            Self::Skipped => delivery_core::JobOutcome::Skipped,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChangedInput {
    pub path: String,
    pub category: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Versions {
    pub ios: String,
    pub android: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlanBody {
    pub format: u32,
    pub repository: String,
    pub source: Revision,
    pub base: Option<Revision>,
    pub requested: Option<Vec<Target>>,
    pub dataset: Option<Digest>,
    pub versions: Versions,
    pub changed: Vec<ChangedInput>,
    pub targets: Vec<Target>,
    pub checks: Vec<Check>,
    pub selection_required: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlanRecord {
    pub plan: PlanBody,
    pub sha256: Digest,
}

impl PlanRecord {
    pub fn seal(plan: PlanBody) -> Result<Self> {
        let sha256 = Digest::of(&serde_json::to_vec(&plan)?);
        Ok(Self { plan, sha256 })
    }
    pub fn validate_digest(&self) -> Result<()> {
        ensure!(
            self.plan.format == PLAN_FORMAT && self.plan.repository == REPOSITORY,
            "Unsupported delivery plan identity"
        );
        ensure!(
            Digest::of(&serde_json::to_vec(&self.plan)?) == self.sha256,
            "The delivery plan changed after preparation"
        );
        Ok(())
    }
}

pub fn category(change: Change) -> &'static str {
    match change {
        Change::Presentation => "presentation",
        Change::WorkerConfiguration => "worker-configuration",
        Change::ServerContract => "server-contract",
        Change::Ios => "ios",
        Change::Android => "android",
        Change::SharedSource => "shared-source",
        Change::Dataset => "dataset",
        Change::CloudflareAlerts => "cloudflare-alerts",
        Change::Monitors => "monitors",
        Change::Automation => "automation",
        Change::Documentation => "documentation",
        Change::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn digest_keeps_canonical_sha256_vectors() {
        for (input, expected) in [
            (
                "",
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ),
            (
                "abc",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
        ] {
            assert_eq!(Digest::of(input.as_bytes()).as_str(), expected);
        }
    }
    #[test]
    fn wire_identities_reject_abbreviated_uppercase_and_non_hex_values() {
        for bad in [
            "",
            "HEAD",
            "1234",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "gggggggggggggggggggggggggggggggggggggggg",
        ] {
            assert!(Revision::try_from(bad.to_owned()).is_err());
        }
        assert!(Revision::try_from("a".repeat(REVISION_BYTES)).is_ok());
        assert!(Digest::try_from("a".repeat(DIGEST_BYTES)).is_ok());
        assert!(Digest::try_from("a".repeat(REVISION_BYTES)).is_err());
        assert!(serde_json::from_str::<Target>("\"worker;publish\"").is_err());
    }
}
