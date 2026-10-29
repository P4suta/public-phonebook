use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use public_phonebook::{model::*, store, web};
use tower::ServiceExt;

mod support;

fn database() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let (mut contacts, prefectures, mut sources) = support::fixture();
    sources[0].url = "https://example.com/providers.ZIP?download=1".into();
    sources[0].index_url = "https://example.com/provider-list".into();
    let contact = contacts.iter_mut().find(|c| c.id == "13:medical").unwrap();
    contact.source_url = "https://example.com/providers.XLSX?download=1".into();
    contact.official_url = Some("https://clinic.example.com/".into());
    let report = store::coverage(&contacts, &prefectures, sources, "fixed".into());
    store::build_database(
        &directory.path().join("phonebook.sqlite"),
        &contacts,
        &report,
    )
    .unwrap();
    directory
}

#[tokio::test]
async fn source_links_open_a_readable_page_before_any_file_download() {
    let directory = database();
    let app = web::router(directory.path().join("phonebook.sqlite")).unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/?prefecture=13&category=medical")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
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
    assert!(html.contains("/contacts/13:medical?"));
    assert!(!html.contains("href=\"https://example.com/providers.XLSX"));
    let response = app
        .oneshot(
            Request::builder()
                .uri("/contacts/13:medical/source?q=test&prefecture=13&category=medical&page=3")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "text/html; charset=utf-8"
    );
    assert!(!response.headers().contains_key("content-disposition"));
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
    assert!(html.contains("公開元のページを見る"));
    assert!(html.contains("https://example.com/provider-list"));
    assert!(html.contains("元のファイルを開く（XLSX）"));
    assert!(html.contains("2026-10-01"));
    assert!(html.contains("2026-10-29"));
    assert!(html.contains("category=medical&#38;page=3"));
    assert!(!html.contains("<script>"));
}

#[tokio::test]
async fn missing_contacts_and_invalid_queries_do_not_render_source_pages() {
    let directory = database();
    let app = web::router(directory.path().join("phonebook.sqlite")).unwrap();
    for (path, status) in [
        ("/contacts/missing/source", StatusCode::NOT_FOUND),
        (
            "/contacts/13:medical/source?page=-1",
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let result = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(result.status(), status);
    }
}

#[tokio::test]
async fn source_navigation_preserves_exports_and_original_provenance() {
    let directory = database();
    let app = web::router(directory.path().join("phonebook.sqlite")).unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/export?format=json&prefecture=13&category=medical")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let records: Vec<Contact> =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        records[0].source_url,
        "https://example.com/providers.XLSX?download=1"
    );
    assert_eq!(records.len(), 1);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/contacts/13:medical.vcf")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment")
    );
}
