use anyhow::Result;
use public_phonebook::{audit, model::*, store};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::io::{self, Write};

mod support;

#[test]
fn csv_text_cells_quote_declared_formula_prefixes_and_preserve_json_values() {
    let mut contact = support::fixture().0.remove(0);
    for first in [
        "=", "+", "-", "@", "\t", "\r", "\n", " ", "＝", "＋", "－", "＠",
    ] {
        contact.name = format!("{first}HYPERLINK(\"https://example.com\")");
        contact.address = contact.name.clone();
        let bytes = store::export(&[contact.clone()], "csv").unwrap().0;
        let record = csv::Reader::from_reader(bytes.as_slice())
            .records()
            .next()
            .unwrap()
            .unwrap();
        assert_eq!(&record[5], format!("'{}", contact.name));
        assert_eq!(&record[6], format!("'{}", contact.address));
        assert_eq!(&record[8], "+81300000000");
        let original: serde_json::Value =
            serde_json::from_slice(&store::export(&[contact.clone()], "json").unwrap().0).unwrap();
        assert_eq!(original[0]["name"], contact.name);
    }
}

fn database() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let (contacts, prefectures, sources) = support::fixture();
    let report = store::coverage(&contacts, &prefectures, sources, "fixed".into());
    store::build_database(
        &directory.path().join("phonebook.sqlite"),
        &contacts,
        &report,
    )
    .unwrap();
    directory
}

#[test]
fn duplicate_prefecture_labels_cannot_claim_national_coverage() {
    let (contacts, mut prefectures, sources) = support::fixture();
    let duplicate = prefectures[12].clone();
    prefectures.fill(duplicate);
    assert!(!store::coverage(&contacts, &prefectures, sources, "fixed".into()).complete);
}

#[test]
fn partial_museum_and_archive_registers_preserve_explicit_zero_cells() {
    for only_tokyo in [false, true] {
        let (mut contacts, prefectures, mut sources) = support::fixture();
        contacts.retain(|contact| {
            contact.category.nationwide_required()
                || (only_tokyo && contact.prefecture_code == "13")
        });
        sources[0].rows = contacts.len();
        sources[0].accepted = contacts.len();
        let report = store::coverage(&contacts, &prefectures, sources, "fixed".into());
        assert!(report.complete);
        assert_eq!(report.prefectures_covered, 47);
        assert_eq!(report.cells.len(), 47 * Category::ALL.len());
        assert!(
            report
                .cells
                .iter()
                .any(|cell| cell.category == Category::Archive && cell.contacts == 0)
        );
        let directory = tempfile::tempdir().unwrap();
        store::build_database(
            &directory.path().join("phonebook.sqlite"),
            &contacts,
            &report,
        )
        .unwrap();
        assert!(audit::verify(directory.path()).is_ok());
    }
}

#[test]
fn missing_nationwide_care_coverage_cannot_activate_a_snapshot() {
    for category in [
        Category::NursingCare,
        Category::DisabilitySupport,
        Category::Library,
    ] {
        let (mut contacts, prefectures, mut sources) = support::fixture();
        contacts.retain(|contact| contact.category != category || contact.prefecture_code != "47");
        sources[0].rows = contacts.len();
        sources[0].accepted = contacts.len();
        let report = store::coverage(&contacts, &prefectures, sources, "fixed".into());
        assert!(!report.complete);
        assert_eq!(report.prefectures_covered, 46);
    }
}

#[test]
fn expansion_audit_distinguishes_additions_from_deleted_and_changed_contacts() {
    let baseline = database();
    let baseline_path = baseline.path().join("phonebook.sqlite");
    let (mut contacts, prefectures, mut sources) = support::fixture();
    let before = contacts.len();
    let mut extra = contacts[0].clone();
    extra.id = "added:office".into();
    extra.name = "Additional office".into();
    contacts.push(extra);
    let build = |contacts: &[Contact], sources: &mut Vec<SourceReport>| {
        sources[0].rows = contacts.len();
        sources[0].accepted = contacts.len();
        let report = store::coverage(contacts, &prefectures, sources.clone(), "fixed".into());
        let directory = tempfile::tempdir().unwrap();
        store::build_database(
            &directory.path().join("phonebook.sqlite"),
            contacts,
            &report,
        )
        .unwrap();
        directory
    };
    let addition = build(&contacts, &mut sources);
    let checked = audit::verify_preserving(addition.path(), &baseline_path).unwrap();
    assert_eq!(
        checked.baseline.unwrap(),
        audit::SnapshotComparison {
            baseline_contacts: before,
            added_contacts: 1,
            removed_contacts: 0,
            changed_contacts: 0
        }
    );
    contacts[1].name = "Changed name".into();
    contacts.retain(|contact| contact.id != "47:archive");
    let changed = build(&contacts, &mut sources);
    assert_eq!(
        audit::compare_snapshot(&changed.path().join("phonebook.sqlite"), &baseline_path).unwrap(),
        audit::SnapshotComparison {
            baseline_contacts: before,
            added_contacts: 1,
            removed_contacts: 1,
            changed_contacts: 1
        }
    );
    assert!(
        audit::verify_preserving(changed.path(), &baseline_path)
            .unwrap_err()
            .to_string()
            .contains("Snapshot preservation failed")
    );
    let absent = baseline.path().join("missing.sqlite");
    assert!(audit::compare_snapshot(&baseline_path, &absent).is_err());
    assert!(!absent.exists());
}

#[test]
fn exports_carry_publisher_attribution_for_added_public_data() {
    let (contacts, _, _) = support::fixture();
    let original = [
        (
            Category::NursingCare,
            "Ministry of Health, Labour and Welfare",
        ),
        (Category::DisabilitySupport, "WAM NET"),
        (Category::Library, "National Diet Library"),
        (Category::Museum, "National Diet Library"),
        (Category::Archive, "National Diet Library"),
    ];
    let services = Category::ALL.into_iter().filter_map(|category| {
        category
            .additional_source()
            .map(|(publisher, _)| (category, publisher))
    });
    for (category, publisher) in original.into_iter().chain(services) {
        let mut contact = contacts[0].clone();
        contact.category = category;
        for format in ["json", "csv", "vcf"] {
            let (bytes, _) = store::export(&[contact.clone()], format).unwrap();
            let text = String::from_utf8(bytes)
                .unwrap()
                .replace("\r\n ", "")
                .replace("\\,", ",");
            assert!(
                text.contains(publisher),
                "{format} lacks publisher attribution for {category:?}"
            );
            assert!(text.contains("adapted by Public Phonebook"), "{format}");
        }
    }
}

#[test]
fn each_source_count_must_match_its_own_contacts() {
    let (contacts, prefectures, mut sources) = support::fixture();
    sources[0].id = "unrelated-source".into();
    assert!(!store::coverage(&contacts, &prefectures, sources, "fixed".into()).complete);
}

#[test]
fn an_extra_contact_outside_the_47_prefectures_is_rejected() {
    let (mut contacts, prefectures, mut sources) = support::fixture();
    let mut extra = contacts[0].clone();
    extra.id = "unknown:medical".into();
    extra.prefecture_code = "48".into();
    contacts.push(extra);
    sources[0].rows += 1;
    sources[0].accepted += 1;
    assert!(!store::coverage(&contacts, &prefectures, sources, "fixed".into()).complete);
}

#[test]
fn invalid_contact_fields_cannot_activate_a_snapshot() {
    for variant in 0..4 {
        let (mut contacts, prefectures, sources) = support::fixture();
        match variant {
            0 => contacts[0].name = "  ".into(),
            1 => contacts[0].phones.clear(),
            2 => contacts[0].phones[0].e164 = "+12125550123".into(),
            _ => contacts[0].municipality_code = Some("48001".into()),
        }
        let report = store::coverage(&contacts, &prefectures, sources, "fixed".into());
        assert!(
            !report.complete,
            "Invalid contact variant {variant} accepted"
        );
    }
}

#[test]
fn database_creation_rejects_metadata_for_another_contact_set() {
    let (mut contacts, prefectures, sources) = support::fixture();
    let report = store::coverage(&contacts, &prefectures, sources, "fixed".into());
    contacts.pop();
    let directory = tempfile::tempdir().unwrap();
    assert!(store::build_database(&directory.path().join("database"), &contacts, &report).is_err());
    assert!(!directory.path().join("database").exists());
}

#[test]
fn audit_detects_phone_index_corruption_even_when_counts_stay_equal() {
    let directory = database();
    assert!(audit::verify(directory.path()).is_ok());
    Connection::open(directory.path().join("phonebook.sqlite"))
        .unwrap()
        .execute("UPDATE phones SET number='+819999999999'", [])
        .unwrap();
    let error = audit::verify(directory.path()).unwrap_err().to_string();
    assert!(error.contains("index mapping"), "{error}");
}

#[test]
fn audit_checks_archived_source_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let (contacts, prefectures, mut sources) = support::fixture();
    let bytes = b"test source snapshot";
    sources[0].url = "https://example.com/source".into();
    sources[0].sha256 = format!("{:x}", Sha256::digest(bytes));
    let raw = directory.path().join("raw/objects");
    std::fs::create_dir_all(&raw).unwrap();
    let artifact = raw.join(format!("{}.bin", sources[0].sha256));
    std::fs::write(&artifact, bytes).unwrap();
    let report = store::coverage(&contacts, &prefectures, sources, "fixed".into());
    store::build_database(
        &directory.path().join("phonebook.sqlite"),
        &contacts,
        &report,
    )
    .unwrap();
    assert!(audit::verify(directory.path()).is_ok());
    std::fs::write(artifact, b"modified source").unwrap();
    assert!(
        audit::verify(directory.path())
            .unwrap_err()
            .to_string()
            .contains("hash mismatch")
    );
}

#[test]
fn streamed_exports_match_records_and_propagate_write_failures() -> Result<()> {
    struct BrokenSink;
    impl Write for BrokenSink {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("injected write failure"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let directory = database();
    let path = directory.path().join("phonebook.sqlite");
    for format in ["json", "csv", "vcf"] {
        assert!(store::write_export(&path, &Search::default(), format, BrokenSink).is_err());
        let mut output = Vec::new();
        store::write_export(
            &path,
            &Search {
                prefecture: "13".into(),
                page: usize::MAX,
                ..Default::default()
            },
            format,
            &mut output,
        )?;
        match format {
            "json" => assert_eq!(
                serde_json::from_slice::<Vec<Contact>>(&output)?.len(),
                Category::ALL.len()
            ),
            "csv" => assert_eq!(
                csv::Reader::from_reader(output.as_slice())
                    .records()
                    .count(),
                Category::ALL.len()
            ),
            _ => assert_eq!(
                std::str::from_utf8(&output)?
                    .matches("BEGIN:VCARD\r\n")
                    .count(),
                Category::ALL.len()
            ),
        }
    }
    Ok(())
}

#[test]
fn empty_exports_are_valid_and_have_no_phantom_contact() -> Result<()> {
    let directory = database();
    let path = directory.path().join("phonebook.sqlite");
    let query = Search {
        q: "No such record".into(),
        ..Default::default()
    };
    for format in ["json", "csv", "vcf"] {
        let mut output = Vec::new();
        store::write_export(&path, &query, format, &mut output)?;
        match format {
            "json" => assert!(serde_json::from_slice::<Vec<Contact>>(&output)?.is_empty()),
            "csv" => assert_eq!(
                csv::Reader::from_reader(output.as_slice())
                    .records()
                    .count(),
                0
            ),
            _ => assert!(output.is_empty()),
        }
    }
    Ok(())
}

#[test]
fn only_public_web_urls_are_exported_as_vcard_links() {
    let mut c = support::fixture().0.remove(0);
    for url in [
        "javascript:alert(1)",
        "data:text/html,hello",
        "file:///tmp/contact",
        "https://user:password@example.com/",
    ] {
        c.official_url = Some(url.into());
        assert!(
            !store::vcard(&c)
                .lines()
                .any(|line| line.starts_with("URL:")),
            "{url}"
        );
    }
    for url in ["https://example.com/", "http://example.com/contact"] {
        c.official_url = Some(url.into());
        assert!(store::vcard(&c).contains(&format!("URL:{url}\r\n")));
    }
}

#[test]
fn paging_and_normalized_names_keep_stable_semantics() {
    let directory = database();
    let path = directory.path().join("phonebook.sqlite");
    let total = 47 * Category::ALL.len();
    for (requested, expected, count) in [
        (0, 1, 50),
        (1, 1, 50),
        (2, 2, 50),
        (usize::MAX, total.div_ceil(50), (total - 1) % 50 + 1),
    ] {
        let result = store::search(
            &path,
            &Search {
                q: "ＴＥＳＴ".into(),
                page: requested,
                ..Default::default()
            },
            true,
        )
        .unwrap();
        assert_eq!((result.page, result.contacts.len()), (expected, count));
    }
    let result = store::search(
        &path,
        &Search {
            municipality: "13001".into(),
            category: "pharmacy".into(),
            ..Default::default()
        },
        false,
    )
    .unwrap();
    assert_eq!(result.total, 1);
    assert_eq!(result.contacts[0].id, "13:pharmacy");
}

#[test]
fn boundary_query_lengths_are_checked_in_utf8_bytes() {
    let directory = database();
    let path = directory.path().join("phonebook.sqlite");
    for query in ["a".repeat(512), "あ".repeat(170)] {
        assert!(
            store::search(
                &path,
                &Search {
                    q: query,
                    ..Default::default()
                },
                true
            )
            .is_ok()
        );
    }
    for query in ["a".repeat(513), "あ".repeat(171)] {
        assert!(
            store::search(
                &path,
                &Search {
                    q: query,
                    ..Default::default()
                },
                true
            )
            .is_err()
        );
    }
}

#[test]
fn failed_staging_preserves_the_active_database_and_cleans_temporary_files() {
    let directory = database();
    let path = directory.path().join("phonebook.sqlite");
    let previous = std::fs::read(&path).unwrap();
    let (mut contacts, prefectures, sources) = support::fixture();
    let report = store::coverage(&contacts, &prefectures, sources, "fixed".into());
    contacts.pop();
    assert!(store::stage_snapshot(directory.path(), &contacts, &report).is_err());
    assert_eq!(std::fs::read(path).unwrap(), previous);
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn staged_data_becomes_visible_only_after_atomic_activation() {
    let directory = database();
    let path = directory.path().join("phonebook.sqlite");
    let (mut contacts, prefectures, sources) = support::fixture();
    contacts[0].name = "Replacement clinic".into();
    let id = contacts[0].id.clone();
    let report = store::coverage(&contacts, &prefectures, sources, "fixed".into());
    let staged = store::stage_snapshot(directory.path(), &contacts, &report).unwrap();
    assert_ne!(
        store::contact(&path, &id).unwrap().name,
        "Replacement clinic"
    );
    staged.persist(&path).unwrap();
    assert_eq!(
        store::contact(&path, &id).unwrap().name,
        "Replacement clinic"
    );
    assert!(audit::verify(directory.path()).is_ok());
}

#[test]
fn every_reader_must_release_its_lock_before_an_update() {
    let directory = tempfile::tempdir().unwrap();
    let first = public_phonebook::import::lock(directory.path(), false).unwrap();
    let second = public_phonebook::import::lock(directory.path(), false).unwrap();
    assert!(public_phonebook::import::lock(directory.path(), true).is_err());
    drop(first);
    assert!(public_phonebook::import::lock(directory.path(), true).is_err());
    drop(second);
    assert!(public_phonebook::import::lock(directory.path(), true).is_ok());
}

#[tokio::test]
async fn simultaneous_readers_return_the_same_complete_results() {
    let directory = database();
    let path = directory.path().join("phonebook.sqlite");
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let path = path.clone();
        tasks.spawn_blocking(move || store::search(&path, &Search::default(), true).unwrap());
    }
    let mut first = None;
    while let Some(result) = tasks.join_next().await {
        let result = result.unwrap();
        assert_eq!(result.total, 47 * Category::ALL.len());
        let ids: Vec<_> = result.contacts.into_iter().map(|c| c.id).collect();
        if let Some(expected) = &first {
            assert_eq!(&ids, expected);
        } else {
            first = Some(ids);
        }
    }
}
