use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use public_phonebook::{import, model::*, store, web};
use tower::ServiceExt;
mod support;
use support::fixture;

fn database() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let (contacts, prefectures, reports) = fixture();
    let report = store::coverage(&contacts, &prefectures, reports, "fixed".into());
    assert!(report.complete);
    store::build_database(
        &directory.path().join("phonebook.sqlite"),
        &contacts,
        &report,
    )
    .unwrap();
    directory
}

#[test]
fn incomplete_data_and_inconsistent_accounting_are_rejected() {
    let (mut contacts, prefectures, mut reports) = fixture();
    reports[0].accepted -= 1;
    reports[0].rows -= 1;
    assert!(!store::coverage(&contacts, &prefectures, reports, "fixed".into()).complete);
    contacts.retain(|c| !(c.prefecture_code == "47" && c.category == Category::Pharmacy));
    let report = store::coverage(
        &contacts,
        &prefectures,
        vec![SourceReport {
            rows: contacts.len(),
            accepted: contacts.len(),
            ..Default::default()
        }],
        "fixed".into(),
    );
    assert_eq!(report.prefectures_covered, 46);
    let temporary = tempfile::tempdir().unwrap();
    assert!(store::build_database(&temporary.path().join("database"), &contacts, &report).is_err());
    assert!(!temporary.path().join("database").exists());
}

#[test]
fn shared_numbers_keep_all_facilities_and_filters_do_not_become_sql() {
    let directory = database();
    let path = directory.path().join("phonebook.sqlite");
    assert_eq!(
        store::search(
            &path,
            &Search {
                q: "０３－００００－００００".into(),
                ..Default::default()
            },
            false
        )
        .unwrap()
        .total,
        47 * Category::ALL.len()
    );
    assert_eq!(
        store::search(
            &path,
            &Search {
                prefecture: "13".into(),
                category: "dental".into(),
                ..Default::default()
            },
            false
        )
        .unwrap()
        .total,
        1
    );
    assert!(
        store::search(
            &path,
            &Search {
                prefecture: "13' OR 1=1 --".into(),
                ..Default::default()
            },
            false
        )
        .is_err()
    );
    assert_eq!(store::load_coverage(&path).unwrap().unique_phone_numbers, 1);
}

#[test]
fn server_lock_prevents_partial_updates() {
    let directory = tempfile::tempdir().unwrap();
    let shared = import::lock(directory.path(), false).unwrap();
    assert!(import::lock(directory.path(), true).is_err());
    drop(shared);
    assert!(import::lock(directory.path(), true).is_ok());
}

#[tokio::test]
async fn html_pages_are_escaped_and_downloads_include_all_matches() {
    let directory = database();
    let app = web::router(directory.path().join("phonebook.sqlite")).unwrap();
    let response = app
        .clone()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let html = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(html.contains(&format!("data-total=\"{}\"", 47 * Category::ALL.len())));
    assert!(html.contains(&format!(
        "1 / {} ページ",
        (47 * Category::ALL.len()).div_ceil(50)
    )));
    assert!(!html.contains("<script>"));
    assert_eq!(html.matches("class=\"contact\"").count(), 50);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/export?format=json&page=2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let exported: Vec<Contact> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(exported.len(), 47 * Category::ALL.len());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/export?format=csv&prefecture=13")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        csv::Reader::from_reader(bytes.as_ref()).records().count(),
        Category::ALL.len()
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/contacts/13:dental.vcf")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let card = std::str::from_utf8(&body).unwrap();
    assert!(card.starts_with("BEGIN:VCARD\r\nVERSION:3.0\r\n"));
    assert!(card.contains("TEL;TYPE=WORK,VOICE:+81300000000\r\n"));
    assert!(card.contains("Test address\\; floor 1"));
    assert!(card.split("\r\n").all(|line| line.len() <= 75));
    let response = app
        .oneshot(
            Request::builder()
                .uri("/export?format=invalid")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
