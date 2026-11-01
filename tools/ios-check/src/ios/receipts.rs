use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};

pub(super) const NATIVE_RECEIPTS: [&str; 4] = [
    "receipt.json",
    "sanitizer-receipt.json",
    "mutation-receipt.json",
    "proof-receipt.json",
];

fn recorded_sources(receipt: &Value) -> Result<BTreeMap<String, String>> {
    let mut sources = BTreeMap::new();
    for record in receipt["source_sha256"]
        .as_array()
        .context("The receipt names no source digests")?
    {
        let path = record["path"].as_str().context("Missing source path")?;
        let digest = record["sha256"].as_str().context("Missing source digest")?;
        ensure!(
            sources.insert(path.to_owned(), digest.to_owned()).is_none(),
            "The receipt repeats {path}"
        );
    }
    Ok(sources)
}

pub(super) fn admit(name: &str, receipt: &Value, sources: &BTreeMap<String, String>) -> Result<()> {
    ensure!(receipt["result"] == "passed", "{name} didn't pass");
    let recorded = recorded_sources(receipt).with_context(|| format!("{name} is malformed"))?;
    if &recorded != sources {
        let changed = recorded
            .keys()
            .chain(sources.keys())
            .filter(|path| recorded.get(*path) != sources.get(*path))
            .collect::<std::collections::BTreeSet<_>>();
        bail!(
            "{name} verified other sources: {}",
            changed
                .into_iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    Ok(())
}

pub(super) fn require(root: &Path, sources: &BTreeMap<String, String>) -> Result<Vec<Value>> {
    let directory = root.join("target/ios");
    let mut admitted = Vec::new();
    for name in NATIVE_RECEIPTS {
        let path = directory.join(name);
        let bytes = fs::read(&path)
            .with_context(|| format!("Signing requires the current native receipt {name}"))?;
        let receipt: Value =
            serde_json::from_slice(&bytes).with_context(|| format!("{name} isn't JSON"))?;
        admit(name, &receipt, sources)?;
        admitted.push(json!({"receipt":name,"sha256":format!("{:x}", Sha256::digest(&bytes))}));
    }
    Ok(admitted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("ios/Sources/Core.swift".to_owned(), "a".repeat(64)),
            ("tools/ios-check/src/ios.rs".to_owned(), "b".repeat(64)),
        ])
    }

    fn passed(sources: &BTreeMap<String, String>) -> Value {
        json!({
            "result":"passed",
            "source_sha256":sources.iter().map(|(path, sha256)| json!({"path":path,"sha256":sha256})).collect::<Vec<_>>()
        })
    }

    #[test]
    fn receipts_for_the_current_sources_are_admitted() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let receipts = directory.path().join("target/ios");
        fs::create_dir_all(&receipts)?;
        for name in NATIVE_RECEIPTS {
            fs::write(
                receipts.join(name),
                serde_json::to_vec(&passed(&sources()))?,
            )?;
        }
        let admitted = require(directory.path(), &sources())?;
        assert_eq!(admitted.len(), NATIVE_RECEIPTS.len());
        Ok(())
    }

    #[test]
    fn signing_is_refused_without_every_receipt() -> Result<()> {
        for missing in NATIVE_RECEIPTS {
            let directory = tempfile::tempdir()?;
            let receipts = directory.path().join("target/ios");
            fs::create_dir_all(&receipts)?;
            for name in NATIVE_RECEIPTS.into_iter().filter(|name| *name != missing) {
                fs::write(
                    receipts.join(name),
                    serde_json::to_vec(&passed(&sources()))?,
                )?;
            }
            let error = require(directory.path(), &sources())
                .err()
                .context("A missing receipt was admitted")?;
            assert!(format!("{error:#}").contains(missing));
        }
        Ok(())
    }

    #[test]
    fn failed_stale_and_malformed_receipts_are_refused() {
        let current = sources();
        let mut failed = passed(&current);
        failed["result"] = json!("failed");
        let mut modified = current.clone();
        modified.insert("ios/Sources/Core.swift".to_owned(), "c".repeat(64));
        let mut added = current.clone();
        added.insert("ios/Sources/Adapter.swift".to_owned(), "d".repeat(64));
        let mut removed = current.clone();
        removed.remove("tools/ios-check/src/ios.rs");
        let mut repeated = passed(&current);
        repeated["source_sha256"]
            .as_array_mut()
            .into_iter()
            .for_each(|records| records.push(records[0].clone()));
        for receipt in [
            failed,
            passed(&modified),
            passed(&added),
            passed(&removed),
            repeated,
            json!({"result":"passed"}),
            json!({"result":"passed","source_sha256":[{"path":"ios/Sources/Core.swift"}]}),
        ] {
            assert!(
                admit("receipt.json", &receipt, &current).is_err(),
                "{receipt}"
            );
        }
        assert!(admit("receipt.json", &passed(&current), &current).is_ok());
    }
}
