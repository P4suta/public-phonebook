use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use public_phonebook::{store, web};
use tower::ServiceExt;

mod support;

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

#[tokio::test]
async fn query_filters_are_validated_before_a_database_search() {
    let directory = database();
    let app = web::router(directory.path().join("phonebook.sqlite")).unwrap();
    for query in [
        "prefecture=48",
        "prefecture=1",
        "municipality=not-a-code",
        "category=unknown",
        "prefecture=01&municipality=13001",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/?{query}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{query}");
        let body = String::from_utf8(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec(),
        )
        .unwrap();
        assert!(body.contains("この検索は"));
    }
}

#[tokio::test]
async fn browser_responses_protect_privacy_and_identify_the_snapshot_and_request() {
    let directory = database();
    let app = web::router(directory.path().join("phonebook.sqlite")).unwrap();
    let mut ids = std::collections::BTreeSet::new();
    for (method, path, status) in [
        ("GET", "/", 200),
        ("GET", "/?page=-1", 400),
        ("GET", "/missing", 404),
        ("POST", "/", 405),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("x-request-id", "untrusted-client-id")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), status);
        let headers = response.headers();
        if status == 405 {
            let allow = headers
                .get("allow")
                .expect("405 must advertise supported methods")
                .to_str()
                .unwrap();
            assert_eq!(
                allow
                    .split(',')
                    .map(str::trim)
                    .collect::<std::collections::BTreeSet<_>>(),
                ["GET", "HEAD"].into_iter().collect()
            );
        }
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(headers["referrer-policy"], "no-referrer");
        assert!(
            headers["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("frame-ancestors 'none'")
        );
        assert!(
            headers["cache-control"]
                .to_str()
                .unwrap()
                .contains("no-store")
        );
        let snapshot = headers["x-public-phonebook-snapshot"].to_str().unwrap();
        assert_eq!(snapshot.len(), 64);
        assert!(snapshot.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let id = headers["x-request-id"].to_str().unwrap().to_owned();
        assert_ne!(id, "untrusted-client-id");
        assert!(ids.insert(id));
    }
}

#[tokio::test]
async fn contact_data_and_feed_views_are_real_navigable_resources() {
    let directory = database();
    let app = web::router(directory.path().join("phonebook.sqlite")).unwrap();
    for (path, expected) in [
        (
            "/contacts/13:library?prefecture=13&category=library&page=1",
            "この番号の出典",
        ),
        ("/data", "入っているデータ"),
        (
            "/internal/search?prefecture=13&category=library",
            "13:library",
        ),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        let body = String::from_utf8(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec(),
        )
        .unwrap();
        assert!(body.contains(expected), "{path}");
    }
}

#[tokio::test]
async fn unavailable_databases_fail_before_export_headers_are_committed() {
    let directory = database();
    let path = directory.path().join("phonebook.sqlite");
    let app = web::router(path.clone()).unwrap();
    std::fs::remove_file(path).unwrap();
    for format in ["json", "csv", "vcf"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/export?format={format}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "{format}"
        );
        assert!(!response.headers().contains_key("content-disposition"));
    }
}

#[tokio::test]
async fn export_capacity_is_reserved_until_the_body_is_consumed() {
    let directory = database();
    let app = web::router_with_limits(
        directory.path().join("phonebook.sqlite"),
        web::ServiceLimits {
            searches: 1,
            exports: 1,
        },
    )
    .unwrap();
    let request = || {
        Request::builder()
            .uri("/export?format=json")
            .body(Body::empty())
            .unwrap()
    };
    let first = app.clone().oneshot(request()).await.unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let blocked = app.clone().oneshot(request()).await.unwrap();
    assert_eq!(blocked.status(), StatusCode::SERVICE_UNAVAILABLE);
    first.into_body().collect().await.unwrap();
    let next = app.oneshot(request()).await.unwrap();
    assert_eq!(next.status(), StatusCode::OK);
}
