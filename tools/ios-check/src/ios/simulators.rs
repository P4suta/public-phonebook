use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{collections::BTreeSet, path::Path, process::Command};

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Record {
    pub id: String,
    pub runtime: String,
    pub booted: bool,
    pub available: bool,
}

pub(super) fn owned(listing: &Value, name: &str, model: &str) -> Result<Vec<Record>> {
    let runtimes = listing["devices"]
        .as_object()
        .context("The simulator device listing is malformed")?;
    let mut identifiers = BTreeSet::new();
    let mut records = Vec::new();
    for (runtime, devices) in runtimes {
        for device in devices
            .as_array()
            .context("The simulator runtime device list is malformed")?
        {
            if device["name"] != name || device["deviceTypeIdentifier"] != model {
                continue;
            }
            let id = device["udid"]
                .as_str()
                .context("The owned simulator has no identifier")?;
            ensure!(
                super::signing::uuid(id) && identifiers.insert(id),
                "The owned simulator identifier is invalid or duplicated"
            );
            ensure!(
                runtime.starts_with("com.apple.CoreSimulator.SimRuntime.")
                    && matches!(device["state"].as_str(), Some("Booted" | "Shutdown")),
                "The owned simulator runtime or state is invalid"
            );
            records.push(Record {
                id: id.to_owned(),
                runtime: runtime.to_owned(),
                booted: device["state"] == "Booted",
                available: device["isAvailable"]
                    .as_bool()
                    .context("The owned simulator availability is missing")?,
            });
        }
    }
    ensure!(
        records.len() <= 1,
        "The owned simulator identity is ambiguous"
    );
    Ok(records)
}

pub(super) fn current(listing: &Value, name: &str, model: &str) -> Result<Record> {
    let mut records = owned(listing, name, model)?;
    ensure!(
        records.len() == 1,
        "The prepared simulator is missing or ambiguous"
    );
    let record = records.pop().context("The prepared simulator is missing")?;
    ensure!(
        record.available,
        "The prepared simulator runtime is unavailable"
    );
    Ok(record)
}

pub(super) fn list(root: &Path) -> Result<Value> {
    let output = super::logged(
        root,
        "simulators",
        Command::new("xcrun").args(["simctl", "list", "devices", "--json"]),
    )?;
    Ok(serde_json::from_slice(&output.stdout)?)
}

pub(super) fn create(root: &Path, name: &str, model: &str) -> Result<Record> {
    let listing = list(root)?;
    let previous = owned(&listing, name, model)?;
    if let Some(device) = previous.first() {
        super::watch::unpair_owned(root, &listing, device)?;
    }
    for device in previous {
        if device.booted {
            super::logged(
                root,
                "shutdown-owned-simulator",
                Command::new("xcrun").args(["simctl", "shutdown", &device.id]),
            )?;
        }
        super::logged(
            root,
            "delete-owned-simulator",
            Command::new("xcrun").args(["simctl", "delete", &device.id]),
        )?;
    }
    let output = super::logged(
        root,
        "create-simulator",
        Command::new("xcrun").args(["simctl", "create", name, model]),
    )?;
    let id = String::from_utf8(output.stdout)?.trim().to_owned();
    ensure!(
        super::signing::uuid(&id),
        "The created simulator identifier is invalid"
    );
    let record = current(&list(root)?, name, model)?;
    ensure!(
        record.id == id,
        "The created simulator doesn't match its device record"
    );
    Ok(record)
}

pub(super) fn pairs_to_remove(
    listing: &Value,
    handhelds: &[Record],
    watches: &[Record],
    resetting: &Record,
) -> Result<Vec<String>> {
    let mut selected = Vec::new();
    for (id, pair) in listing["pairs"]
        .as_object()
        .context("The simulator pair listing is malformed")?
    {
        if pair["phone"]["udid"] != resetting.id && pair["watch"]["udid"] != resetting.id {
            continue;
        }
        let owns_handheld = handhelds
            .iter()
            .any(|device| pair["phone"]["udid"] == device.id);
        let owns_watch = watches
            .iter()
            .any(|watch| pair["watch"]["udid"] == watch.id);
        ensure!(
            owns_handheld && owns_watch && super::signing::uuid(id),
            "An owned test simulator is paired to another device"
        );
        selected.push(id.to_owned());
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MODEL: &str = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
    const ID: &str = "12345678-1234-1234-1234-123456789012";

    fn device(name: &str) -> Value {
        json!({"name":name,"deviceTypeIdentifier":MODEL,"udid":ID,"state":"Shutdown","isAvailable":true})
    }

    #[test]
    fn owned_devices_follow_the_runtime_reported_by_coresimulator() -> Result<()> {
        let runtime = "com.apple.CoreSimulator.SimRuntime.iOS-27-2";
        let listing = json!({"devices":{
            "com.apple.CoreSimulator.SimRuntime.iOS-27-0":[],
            runtime:[device("owned"), device("another project")],
            "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4":[]
        }});
        assert_eq!(
            owned(&listing, "owned", MODEL)?,
            vec![Record {
                id: ID.to_owned(),
                runtime: runtime.to_owned(),
                booted: false,
                available: true
            }]
        );
        Ok(())
    }

    #[test]
    fn created_devices_require_one_available_identity_across_runtimes() -> Result<()> {
        let runtime = "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4";
        let mut listing = json!({"devices":{runtime:[device("owned")]}});
        assert_eq!(current(&listing, "owned", MODEL)?.runtime, runtime);
        listing["devices"][runtime][0]["isAvailable"] = json!(false);
        assert!(!owned(&listing, "owned", MODEL)?[0].available);
        assert!(current(&listing, "owned", MODEL).is_err());
        listing["devices"][runtime][0]["isAvailable"] = json!(true);
        listing["devices"][runtime][0]["udid"] = json!("invalid");
        assert!(owned(&listing, "owned", MODEL).is_err());
        listing["devices"][runtime] = json!([device("owned"), device("owned")]);
        assert!(owned(&listing, "owned", MODEL).is_err());
        listing["devices"][runtime] = json!([]);
        assert!(current(&listing, "owned", MODEL).is_err());
        assert!(owned(&json!({}), "owned", MODEL).is_err());
        Ok(())
    }

    #[test]
    fn cleanup_requires_an_unambiguous_identity_even_across_runtimes() -> Result<()> {
        let runtime = "com.apple.CoreSimulator.SimRuntime.iOS-27-2";
        let mut duplicate = device("owned");
        duplicate["udid"] = json!("ABCDEF12-1234-1234-1234-123456789012");
        for listing in [
            json!({"devices":{runtime:[device("owned"), duplicate.clone()]}}),
            json!({"devices":{
                runtime:[device("owned")],
                "com.apple.CoreSimulator.SimRuntime.iOS-27-0":[duplicate]
            }}),
        ] {
            assert!(owned(&listing, "owned", MODEL).is_err());
        }
        assert!(owned(&json!({"devices":{runtime:[]}}), "owned", MODEL)?.is_empty());
        Ok(())
    }

    #[test]
    fn resetting_owned_devices_cannot_unpair_a_foreign_simulator() -> Result<()> {
        let records = owned(
            &json!({"devices":{
                "com.apple.CoreSimulator.SimRuntime.iOS-27-2":[device("owned")]
            }}),
            "owned",
            MODEL,
        )?;
        let watch_id = "ABCDEF12-1234-1234-1234-123456789012";
        let watches = vec![Record {
            id: watch_id.to_owned(),
            runtime: "com.apple.CoreSimulator.SimRuntime.watchOS-27-2".to_owned(),
            booted: false,
            available: true,
        }];
        let pair = json!({"phone":{"udid":ID},"watch":{"udid":watch_id}});
        let mut listing = json!({"pairs":{ID:pair}});
        assert_eq!(
            pairs_to_remove(&listing, &records, &watches, &records[0])?,
            vec![ID]
        );
        listing["pairs"][ID]["watch"]["udid"] = json!("a foreign Watch");
        assert!(pairs_to_remove(&listing, &records, &watches, &records[0]).is_err());
        listing["pairs"][ID]["watch"]["udid"] = json!(watch_id);
        listing["pairs"][ID]["phone"]["udid"] = json!("a foreign phone");
        assert!(pairs_to_remove(&listing, &records, &watches, &watches[0]).is_err());
        listing["pairs"][ID]["watch"]["udid"] = json!("a foreign Watch");
        listing["pairs"][ID]["phone"]["udid"] = json!("a foreign phone");
        assert!(pairs_to_remove(&listing, &records, &watches, &records[0])?.is_empty());
        assert!(pairs_to_remove(&json!({}), &records, &watches, &records[0]).is_err());
        Ok(())
    }
}
