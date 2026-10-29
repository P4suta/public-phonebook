use axum::{
    Router,
    body::{Body, Bytes},
    http::{HeaderMap, Request, StatusCode},
};
use http_body_util::BodyExt;
use public_phonebook::{store, web};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use tower::ServiceExt;

mod support;

fn database() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let (mut contacts, prefectures, mut sources) = support::fixture();
    let sample = contacts
        .iter()
        .find(|contact| contact.id == "13:medical")
        .unwrap()
        .clone();
    for number in 1..=73 {
        let mut contact = sample.clone();
        contact.id = format!("13:medical:{number:03}");
        contact.name = format!("Additional medical {number}");
        contacts.push(contact);
    }
    sources[0].rows = contacts.len();
    sources[0].accepted = contacts.len();
    let report = store::coverage(
        &contacts,
        &prefectures,
        sources,
        "2026-10-29T00:00:00Z".into(),
    );
    store::build_database(
        &directory.path().join("phonebook.sqlite"),
        &contacts,
        &report,
    )
    .unwrap();
    directory
}

struct Actual {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
}

impl Actual {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

async fn request(app: &Router, method: &str, path: &str) -> Actual {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("origin", "https://consumer.example")
                .header("x-request-id", "untrusted-client-id")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    Actual {
        status: parts.status,
        headers: parts.headers,
        body: body.collect().await.unwrap().to_bytes(),
    }
}

fn schema(document: &Value, path: &str, status: &str, mime: &str) -> jsonschema::Validator {
    let response = &document["paths"][path]["get"]["responses"][status]["content"][mime]["schema"];
    assert!(
        response.is_object(),
        "Missing {status} {mime} schema for {path}"
    );
    jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "components": document["components"],
            "allOf": [response]
        }))
        .unwrap()
}

#[tokio::test]
async fn public_api_exposes_discovery_catalog_and_source_attribution_without_credentials() {
    let directory = database();
    let app = web::router(directory.path().join("phonebook.sqlite")).unwrap();
    let discovery = request(&app, "GET", "/api").await;
    assert_eq!(discovery.status, StatusCode::OK);
    let discovery = discovery.json();
    assert_eq!(discovery["data"]["documentation"], "/api/docs");
    assert_eq!(discovery["data"]["openapi"], "/api/openapi.json");
    let catalog = request(&app, "GET", discovery["data"]["catalog"].as_str().unwrap()).await;
    assert_eq!(catalog.status, StatusCode::OK);
    let catalog = catalog.json();
    assert_eq!(catalog["data"]["categories"].as_array().unwrap().len(), 39);
    assert_eq!(catalog["data"]["prefectures"].as_array().unwrap().len(), 47);
    assert_eq!(
        catalog["data"]["coverage"].as_array().unwrap().len(),
        47 * 39
    );
    assert_eq!(
        catalog["data"]["municipalities"].as_array().unwrap().len(),
        47
    );
    assert_eq!(catalog["data"]["contacts"], 47 * 39 + 73);
    let contact = request(&app, "GET", "/api/contacts/13:medical")
        .await
        .json();
    let data = &contact["data"];
    assert_eq!(data["phones"][0]["e164"], "+81300000000");
    for field in [
        "source_id",
        "source_url",
        "license",
        "license_url",
        "data_as_of",
        "retrieved_at",
        "attribution",
    ] {
        assert!(
            !data[field].as_str().unwrap().is_empty(),
            "Missing provenance {field}"
        );
    }
    let source = request(&app, "GET", data["links"]["source"].as_str().unwrap()).await;
    assert_eq!(source.status, StatusCode::OK);
    assert_eq!(source.json()["data"]["id"], "test");
    let vcard = request(&app, "GET", data["links"]["vcard"].as_str().unwrap()).await;
    assert_eq!(vcard.status, StatusCode::OK);
    assert!(vcard.body.starts_with(b"BEGIN:VCARD\r\n"));
    assert_eq!(vcard.headers["access-control-allow-origin"], "*");
}

#[tokio::test]
async fn pagination_links_pin_the_snapshot_preserve_filters_and_match_the_complete_export() {
    let directory = database();
    let app = web::router(directory.path().join("phonebook.sqlite")).unwrap();
    let first = request(&app, "GET", "/api/contacts?prefecture=13&category=medical").await;
    assert_eq!(first.status, StatusCode::OK);
    let first = first.json();
    assert_eq!(first["meta"]["total"], 74);
    assert_eq!(first["meta"]["page_size"], 50);
    assert_eq!(first["meta"]["total_pages"], 2);
    assert!(first["links"]["previous"].is_null());
    let snapshot = first["meta"]["snapshot"].as_str().unwrap();
    let next = first["links"]["next"].as_str().unwrap();
    assert!(next.contains(&format!("snapshot={snapshot}")));
    let next_url = url::Url::parse(&format!("http://localhost{next}")).unwrap();
    let parameters: std::collections::BTreeMap<_, _> =
        next_url.query_pairs().into_owned().collect();
    assert_eq!(parameters["prefecture"], "13");
    assert_eq!(parameters["category"], "medical");
    assert_eq!(parameters["page"], "2");
    let second = request(&app, "GET", next).await.json();
    assert_eq!(second["data"].as_array().unwrap().len(), 24);
    assert!(second["links"]["next"].is_null());
    assert_eq!(second["meta"]["snapshot"], first["meta"]["snapshot"]);
    let ids: BTreeSet<_> = first["data"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["data"].as_array().unwrap())
        .map(|contact| contact["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 74);
    let export = request(&app, "GET", first["exports"]["json"].as_str().unwrap()).await;
    assert_eq!(export.status, StatusCode::OK);
    let export = export.json();
    let exported: BTreeSet<_> = export
        .as_array()
        .unwrap()
        .iter()
        .map(|contact| contact["id"].as_str().unwrap())
        .collect();
    assert_eq!(exported, ids);
    let empty = request(&app, "GET", "/api/contacts?q=no-matching-facility")
        .await
        .json();
    assert_eq!(empty["data"], json!([]));
    assert_eq!(empty["meta"]["total"], 0);
    assert!(empty["links"]["next"].is_null());
}

#[tokio::test]
async fn invalid_requests_return_actionable_problem_json_instead_of_html() {
    let directory = database();
    let app = web::router(directory.path().join("phonebook.sqlite")).unwrap();
    for (method, path, status, code) in [
        ("GET", "/api/contacts?prefecture=48", 400, "invalid_query"),
        (
            "GET",
            "/api/contacts?prefecture=13&municipality=14001",
            400,
            "invalid_query",
        ),
        (
            "GET",
            "/api/contacts?category=unknown",
            400,
            "invalid_query",
        ),
        ("GET", "/api/contacts?page=0", 400, "invalid_query"),
        ("GET", "/api/contacts?page=999999", 400, "invalid_query"),
        ("GET", "/api/contacts?page=-1", 400, "invalid_query"),
        (
            "GET",
            "/api/contacts?page=18446744073709551616",
            400,
            "invalid_query",
        ),
        ("GET", "/api/contacts?prefecutre=13", 400, "invalid_query"),
        (
            "GET",
            "/api/contacts?q=first&q=second",
            400,
            "invalid_query",
        ),
        (
            "GET",
            "/api/contacts?snapshot=not-a-digest",
            400,
            "invalid_query",
        ),
        ("GET", "/api/export?format=unknown", 400, "invalid_query"),
        ("GET", "/api/export?page=2", 400, "invalid_query"),
        ("GET", "/api/contacts/missing", 404, "not_found"),
        ("GET", "/api/sources/missing", 404, "not_found"),
        ("GET", "/api/missing?private=value", 404, "not_found"),
        ("GET", "/api/contacts/%FF", 400, "invalid_query"),
        ("POST", "/api/contacts", 405, "method_not_allowed"),
    ] {
        let actual = request(&app, method, path).await;
        assert_eq!(actual.status.as_u16(), status, "{method} {path}");
        assert_eq!(actual.headers["content-type"], "application/problem+json");
        assert_eq!(actual.headers["access-control-allow-origin"], "*");
        assert_eq!(actual.headers["cache-control"], "no-store");
        let body = actual.json();
        assert_eq!(body["status"], status);
        assert_eq!(body["code"], code);
        assert_eq!(
            body["request_id"],
            actual.headers["x-request-id"].to_str().unwrap()
        );
        assert_ne!(body["request_id"], "untrusted-client-id");
        assert!(body["type"].as_str().unwrap().starts_with("/api/docs#"));
        assert!(body["detail"].as_str().unwrap().len() > 10);
        assert!(!String::from_utf8_lossy(&actual.body).contains("private=value"));
        if status == 400 {
            assert!(!body["invalid_parameters"].as_array().unwrap().is_empty());
        }
    }
    for path in [
        "/api/contacts",
        "/api/contacts/13:medical",
        "/api/sources",
        "/api/sources/test",
        "/api/catalog",
        "/api/export",
    ] {
        let actual = request(&app, "GET", &format!("{path}?snapshot={}", "0".repeat(64))).await;
        assert_eq!(actual.status, StatusCode::CONFLICT, "{path}");
        assert_eq!(actual.json()["code"], "snapshot_changed");
    }
}

#[tokio::test]
async fn actual_responses_match_the_generated_openapi_and_a_broken_response_is_rejected() {
    let directory = database();
    let app = web::router(directory.path().join("phonebook.sqlite")).unwrap();
    let actual = request(&app, "GET", "/api/openapi.json").await;
    assert_eq!(actual.status, StatusCode::OK);
    let document = actual.json();
    assert!(document["openapi"].as_str().unwrap().starts_with("3.1."));
    assert_eq!(document["servers"][0]["url"], "/");
    assert!(document["components"]["securitySchemes"].is_null());
    let catalog = request(&app, "GET", "/api/catalog").await.json();
    let declared: BTreeSet<_> = document["components"]["schemas"]["Category"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    let offered: BTreeSet<_> = catalog["data"]["categories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value["id"].as_str().unwrap())
        .collect();
    assert_eq!(declared, offered);
    for (path, template, status) in [
        ("/api", "/api", "200"),
        (
            "/api/contacts?prefecture=13&category=medical",
            "/api/contacts",
            "200",
        ),
        ("/api/contacts/13:medical", "/api/contacts/{id}", "200"),
        ("/api/catalog", "/api/catalog", "200"),
        (
            "/api/export?prefecture=13&category=medical",
            "/api/export",
            "200",
        ),
        ("/api/sources", "/api/sources", "200"),
        ("/api/sources/test", "/api/sources/{id}", "200"),
        ("/api/contacts?prefecture=48", "/api/contacts", "400"),
        ("/api/contacts/missing", "/api/contacts/{id}", "404"),
    ] {
        let actual = request(&app, "GET", path).await;
        let mime = if status == "200" {
            "application/json"
        } else {
            "application/problem+json"
        };
        let validator = schema(&document, template, status, mime);
        let value = actual.json();
        assert!(
            validator.is_valid(&value),
            "{path}: {:?}",
            validator.iter_errors(&value).collect::<Vec<_>>()
        );
    }
    let validator = schema(&document, "/api/contacts", "200", "application/json");
    let mut invalid = request(&app, "GET", "/api/contacts").await.json();
    invalid["data"][0]["phones"][0]["e164"] = json!(123);
    assert!(!validator.is_valid(&invalid));
    let mut invalid = request(&app, "GET", "/api/contacts").await.json();
    invalid.as_object_mut().unwrap().remove("meta");
    assert!(!validator.is_valid(&invalid));
}

#[tokio::test]
async fn cors_and_head_serve_external_readers_without_returning_export_bytes() {
    let directory = database();
    let app = web::router(directory.path().join("phonebook.sqlite")).unwrap();
    for path in ["/api", "/api/contacts", "/api/missing", "/api/export"] {
        let options = request(&app, "OPTIONS", path).await;
        assert_eq!(options.status, StatusCode::NO_CONTENT);
        assert_eq!(options.headers["access-control-allow-origin"], "*");
        assert_eq!(
            options.headers["access-control-allow-methods"],
            "GET, HEAD, OPTIONS"
        );
        assert!(options.body.is_empty());
        let head = request(&app, "HEAD", path).await;
        assert!(head.body.is_empty(), "HEAD {path}");
        assert_eq!(head.headers["access-control-allow-origin"], "*");
    }
    let response = request(&app, "GET", "/api/contacts?prefecture=13&category=medical").await;
    assert_eq!(response.status, StatusCode::OK);
}

#[tokio::test]
async fn public_export_failures_remain_problem_json_before_download_headers() {
    let directory = database();
    let path = directory.path().join("phonebook.sqlite");
    let app = web::router(path.clone()).unwrap();
    std::fs::remove_file(path).unwrap();
    for path in ["/api/contacts", "/api/export?format=csv"] {
        let response = request(&app, "GET", path).await;
        assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers["content-type"], "application/problem+json");
        assert_eq!(response.headers["retry-after"], "1");
        assert!(response.headers.get("content-disposition").is_none());
        assert_eq!(response.json()["code"], "unavailable");
    }
}

#[tokio::test]
async fn returned_resource_links_round_trip_opaque_unicode_and_reserved_identifiers() {
    let directory = tempfile::tempdir().unwrap();
    let (mut contacts, prefectures, mut sources) = support::fixture();
    let contact_id = "13:medical/試験?& #";
    let source_id = "source/資料?&#";
    for contact in &mut contacts {
        contact.source_id = source_id.into();
    }
    let contact = contacts
        .iter_mut()
        .find(|contact| contact.id == "13:medical")
        .unwrap();
    contact.id = contact_id.into();
    contact.name = "Opaque ID lookup".into();
    sources[0].id = source_id.into();
    let report = store::coverage(
        &contacts,
        &prefectures,
        sources,
        "2026-10-29T00:00:00Z".into(),
    );
    let path = directory.path().join("phonebook.sqlite");
    store::build_database(&path, &contacts, &report).unwrap();
    let app = web::router(path).unwrap();
    let listing = request(&app, "GET", "/api/contacts?q=Opaque+ID+lookup")
        .await
        .json();
    let contact = &listing["data"][0];
    assert_eq!(contact["id"], contact_id);
    for relation in ["self", "source", "vcard"] {
        let link = contact["links"][relation].as_str().unwrap();
        assert!(link.starts_with("/api/"));
        assert!(!link.contains(' '));
        assert!(!link.contains('#'));
        let response = request(&app, "GET", link).await;
        assert_eq!(response.status, StatusCode::OK, "{relation}: {link}");
        if relation == "self" {
            assert_eq!(response.json()["data"]["id"], contact_id);
        }
        if relation == "source" {
            assert_eq!(response.json()["data"]["id"], source_id);
        }
    }
}

#[tokio::test]
async fn query_length_is_measured_in_utf8_bytes_and_reports_the_actual_parameter() {
    let directory = database();
    let app = web::router(directory.path().join("phonebook.sqlite")).unwrap();
    for (characters, expected) in [(170, StatusCode::OK), (171, StatusCode::BAD_REQUEST)] {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("q", &"字".repeat(characters))
            .finish();
        let response = request(&app, "GET", &format!("/api/contacts?{query}")).await;
        assert_eq!(response.status, expected);
        if expected == StatusCode::BAD_REQUEST {
            assert_eq!(response.json()["invalid_parameters"][0]["name"], "q");
        }
    }
}
