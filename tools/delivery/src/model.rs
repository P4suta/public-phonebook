use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::fmt;

pub const REPOSITORY: &str = "P4suta/public-phonebook";
pub const GITHUB_ORIGIN: &str = "https://github.com";
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
