use public_phonebook::{model::SourceReport, snapshot, store, web};
use sha2::{Digest, Sha256};

mod support;

fn database() -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("input");
    std::fs::create_dir_all(input.join("raw/objects")).unwrap();
    let (contacts, prefectures, _) = support::fixture();
    let bytes = b"published source";
    let sha256 = format!("{:x}", Sha256::digest(bytes));
    let artifact = input.join(format!("raw/objects/{sha256}.bin"));
    std::fs::write(&artifact, bytes).unwrap();
    let sources = vec![SourceReport {
        id: "test".into(),
        url: "https://example.com/source".into(),
        sha256,
        rows: contacts.len(),
        accepted: contacts.len(),
        ..Default::default()
    }];
    let coverage = store::coverage(&contacts, &prefectures, sources, "fixed".into());
    store::build_database(&input.join("phonebook.sqlite"), &contacts, &coverage).unwrap();
    (directory, artifact)
}

#[test]
fn service_snapshots_bind_the_exact_database_and_exclude_raw_archives() {
    let (directory, _) = database();
    let input = directory.path().join("input");
    let output = directory.path().join("service");
    let manifest = snapshot::prepare(&input, &output).unwrap();
    assert_eq!(
        manifest.contacts,
        47 * public_phonebook::model::Category::ALL.len()
    );
    assert_eq!(
        manifest.sha256,
        snapshot::digest(&input.join("phonebook.sqlite")).unwrap()
    );
    assert_eq!(
        manifest.sha256,
        snapshot::digest(&output.join("phonebook.sqlite")).unwrap()
    );
    assert!(!output.join("raw").exists());
    assert!(output.join("directory.lock").is_file());
    assert!(web::router(output.join("phonebook.sqlite")).is_ok());
    assert!(snapshot::prepare(&input, &output).is_err());
    let original = std::fs::read(output.join("snapshot.json")).unwrap();
    let mut altered = manifest;
    altered.contacts += 1;
    std::fs::write(
        output.join("snapshot.json"),
        serde_json::to_vec(&altered).unwrap(),
    )
    .unwrap();
    assert!(web::router(output.join("phonebook.sqlite")).is_err());
    std::fs::write(output.join("snapshot.json"), original).unwrap();
    rusqlite::Connection::open(output.join("phonebook.sqlite"))
        .unwrap()
        .execute(
            "UPDATE contacts SET name='altered' WHERE id='13:medical'",
            [],
        )
        .unwrap();
    assert!(web::router(output.join("phonebook.sqlite")).is_err());
}

#[test]
fn corrupted_sources_cannot_create_a_service_snapshot() {
    let (directory, artifact) = database();
    std::fs::write(artifact, b"corrupted").unwrap();
    let output = directory.path().join("service");
    assert!(snapshot::prepare(&directory.path().join("input"), &output).is_err());
    assert!(!output.exists());
}

#[test]
fn prepared_service_mode_refuses_a_missing_manifest_before_binding_a_port() {
    let (directory, _) = database();
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_public-phonebook"))
        .arg("--data")
        .arg(directory.path().join("input"))
        .args(["serve", "--require-manifest", "--port", "0"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("Service snapshot manifest is required")
    );
}

#[test]
fn legacy_bundles_gain_a_covering_name_index_without_changing_the_source_or_records() {
    let (directory, _) = database();
    let input = directory.path().join("input/phonebook.sqlite");
    rusqlite::Connection::open(&input)
        .unwrap()
        .execute_batch("DROP INDEX IF EXISTS contact_name;")
        .unwrap();
    let before = snapshot::digest(&input).unwrap();
    let output = directory.path().join("indexed");
    let manifest = snapshot::prepare(input.parent().unwrap(), &output).unwrap();
    let prepared = output.join("phonebook.sqlite");
    let connection = store::open(&prepared).unwrap();
    let columns = connection
        .prepare("SELECT name FROM pragma_index_info('contact_name') ORDER BY seqno")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(columns, ["name", "id"]);
    assert_eq!(snapshot::digest(&input).unwrap(), before);
    assert_eq!(manifest.sha256, snapshot::digest(&prepared).unwrap());
    let comparison = public_phonebook::audit::compare_snapshot(&prepared, &input).unwrap();
    assert_eq!(comparison.added_contacts, 0);
    assert_eq!(comparison.removed_contacts, 0);
    assert_eq!(comparison.changed_contacts, 0);
}
