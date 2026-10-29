mod contracts;
mod problem;

use super::{App, RequestContext, Shell, lookup, render, selected_contact};
use crate::{
    model::{Category, Contact, Search, SearchError},
    store,
};
use axum::{
    Extension, Router,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use contracts::*;
use phonebook_core::{ExportFormat, MunicipalityCode, PageWindow, SnapshotId};
use std::sync::Arc;
use utoipa::OpenApi;

use problem::Problem;
pub(super) use problem::{ApiError, apply_cors, failure};

type Parameters<T> = Result<Query<T>, QueryRejection>;

pub(super) fn is_public(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

fn parsed<T>(query: Parameters<T>) -> Result<T, ApiError> {
    query.map(|Query(value)| value).map_err(|_| ApiError::invalid("query", "Unknown, repeated or incorrectly typed query parameter. See /api/docs for allowed parameters."))
}

fn check_snapshot(app: &App, value: Option<&str>) -> Result<(), ApiError> {
    let Some(value) = value else {
        return Ok(());
    };
    let identity = value
        .as_bytes()
        .try_into()
        .ok()
        .and_then(SnapshotId::parse)
        .ok_or_else(|| {
            ApiError::invalid(
                "snapshot",
                "Use the 64-character lowercase SHA-256 snapshot identity returned by /api.",
            )
        })?;
    if identity.bytes().as_slice() != app.snapshot.as_bytes() {
        return Err(ApiError::from_status(StatusCode::CONFLICT));
    }
    Ok(())
}

fn checked_search(
    q: Option<String>,
    prefecture: Option<String>,
    municipality: Option<String>,
    category: Option<String>,
    page: usize,
) -> Result<Search, ApiError> {
    if page == 0 {
        return Err(ApiError::invalid(
            "page",
            "Page numbers start at 1. Follow the returned next link for later pages.",
        ));
    }
    let search = Search {
        q: q.unwrap_or_default(),
        prefecture: prefecture.unwrap_or_default(),
        municipality: municipality.unwrap_or_default(),
        category: category.unwrap_or_default(),
        page,
        format: String::new(),
    };
    search.checked().map_err(|error| match error {
        SearchError::TooLong => ApiError::invalid("q", "Use at most 512 UTF-8 bytes for the name or complete telephone number."),
        SearchError::Prefecture => ApiError::invalid("prefecture", "Use a two-digit prefecture code from 01 through 47. Available codes are listed at /api/catalog."),
        SearchError::Municipality => ApiError::invalid("municipality", "Use a five-digit municipality code from /api/catalog."),
        SearchError::ConflictingRegion => ApiError::invalid("municipality", "The municipality must belong to the selected prefecture."),
        SearchError::Category => ApiError::invalid("category", "Use a category identifier from /api/catalog."),
        SearchError::Format => ApiError::invalid("format", "Use json, csv or vcf."),
    })?;
    Ok(search)
}

fn snapshot_meta(app: &App) -> SnapshotMeta {
    SnapshotMeta {
        snapshot: app.snapshot.clone(),
        generated_at: app.coverage.generated_at.clone(),
    }
}

fn filtered_url(
    path: &str,
    query: &Search,
    page: Option<usize>,
    snapshot: &str,
    format: Option<ExportFormat>,
) -> String {
    let mut parameters = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in [
        ("q", &query.q),
        ("prefecture", &query.prefecture),
        ("municipality", &query.municipality),
        ("category", &query.category),
    ] {
        if !value.is_empty() {
            parameters.append_pair(key, value);
        }
    }
    if let Some(format) = format {
        parameters.append_pair("format", format.extension());
    }
    if let Some(page) = page {
        parameters.append_pair("page", &page.to_string());
    }
    parameters.append_pair("snapshot", snapshot);
    format!("{path}?{}", parameters.finish())
}

fn resource_path(segments: &[&str]) -> String {
    const RESOURCE_BASE: &str = "http://directory.invalid/";
    let mut url = url::Url::parse(RESOURCE_BASE).expect("constant base URL");
    url.path_segments_mut()
        .expect("base URL supports paths")
        .clear()
        .extend(segments.iter().copied());
    url.path().to_owned()
}

fn pinned_path(segments: &[&str], snapshot: &str) -> String {
    filtered_url(
        &resource_path(segments),
        &Search::default(),
        None,
        snapshot,
        None,
    )
}

fn public_contact(contact: Contact, app: &App) -> PublicContact {
    let attribution = if contact.category.attribution().is_empty() {
        format!(
            "Source: {}; adapted by Public Phonebook",
            contact.source_url
        )
    } else {
        contact.category.attribution().to_owned()
    };
    let links = ContactLinks {
        self_url: pinned_path(&["api", "contacts", &contact.id], &app.snapshot),
        source: pinned_path(&["api", "sources", &contact.source_id], &app.snapshot),
        web: resource_path(&["contacts", &contact.id]),
        vcard: pinned_path(&["api", "contacts", &contact.id, "vcard"], &app.snapshot),
    };
    PublicContact {
        contact,
        attribution,
        links,
    }
}

fn page_links(path: &str, query: &Search, window: PageWindow, snapshot: &str) -> PageLinks {
    let link = |page| filtered_url(path, query, Some(page), snapshot, None);
    PageLinks {
        self_url: link(window.page()),
        first: link(1),
        previous: (window.page() > 1).then(|| link(window.page() - 1)),
        next: (window.page() < window.pages()).then(|| link(window.page() + 1)),
        last: link(window.pages()),
    }
}

fn page_meta(app: &App, total: usize, window: PageWindow) -> PageMeta {
    PageMeta {
        snapshot: snapshot_meta(app),
        page: window.page(),
        page_size: phonebook_core::PAGE_SIZE,
        total,
        total_pages: window.pages(),
    }
}

fn download_links(query: &Search, snapshot: &str) -> DownloadLinks {
    let link = |format| filtered_url("/api/export", query, None, snapshot, Some(format));
    DownloadLinks {
        json: link(ExportFormat::Json),
        csv: link(ExportFormat::Csv),
        vcf: link(ExportFormat::Vcf),
    }
}

fn page_out_of_range() -> ApiError {
    ApiError::invalid(
        "page",
        "This page is beyond the last page. Use the first, previous, next and last links returned by the collection.",
    )
}

#[utoipa::path(get, path = "/api", operation_id = "discoverApi", params(SnapshotQuery),
    responses((status = 200, body = Discovery), (status = 400, body = Problem, content_type = "application/problem+json"), (status = 409, body = Problem, content_type = "application/problem+json")))]
async fn index(
    State(app): State<Arc<App>>,
    Extension(context): Extension<RequestContext>,
    query: Parameters<SnapshotQuery>,
) -> Response {
    let result = (|| {
        let query = parsed(query)?;
        check_snapshot(&app, query.snapshot.as_deref())?;
        Ok(Discovery {
            data: Endpoints {
                contacts: pinned_path(&["api", "contacts"], &app.snapshot),
                sources: pinned_path(&["api", "sources"], &app.snapshot),
                catalog: pinned_path(&["api", "catalog"], &app.snapshot),
                exports: download_links(&Search::default(), &app.snapshot),
                documentation: "/api/docs",
                openapi: "/api/openapi.json",
            },
            meta: snapshot_meta(&app),
        })
    })();
    match result {
        Ok(value) => axum::Json(value).into_response(),
        Err(error) => failure(error, &context),
    }
}

#[utoipa::path(get, path = "/api/contacts", operation_id = "searchContacts", params(ContactsQuery),
    responses((status = 200, body = ContactCollection), (status = 400, body = Problem, content_type = "application/problem+json"), (status = 409, body = Problem, content_type = "application/problem+json"), (status = 503, body = Problem, content_type = "application/problem+json")))]
async fn contacts(
    State(app): State<Arc<App>>,
    Extension(context): Extension<RequestContext>,
    query: Parameters<ContactsQuery>,
) -> Response {
    let result = async {
        let query = parsed(query)?;
        check_snapshot(&app, query.snapshot.as_deref())?;
        let query = checked_search(
            query.q,
            query.prefecture,
            query.municipality,
            query.category,
            query.page.unwrap_or(1),
        )?;
        let result = lookup(&app, &query).await.map_err(ApiError::from_status)?;
        if result.page != query.page {
            return Err(page_out_of_range());
        }
        let window = PageWindow::new(result.total, result.page);
        Ok(ContactCollection {
            data: result
                .contacts
                .into_iter()
                .map(|value| public_contact(value, &app))
                .collect(),
            meta: page_meta(&app, result.total, window),
            links: page_links("/api/contacts", &query, window, &app.snapshot),
            exports: download_links(&query, &app.snapshot),
        })
    }
    .await;
    match result {
        Ok(value) => axum::Json(value).into_response(),
        Err(error) => failure(error, &context),
    }
}

#[utoipa::path(get, path = "/api/contacts/{id}", operation_id = "getContact", params(("id" = String, Path, description = "Opaque contact identifier returned by search"), SnapshotQuery),
    responses((status = 200, body = ContactResponse), (status = 400, body = Problem, content_type = "application/problem+json"), (status = 404, body = Problem, content_type = "application/problem+json"), (status = 409, body = Problem, content_type = "application/problem+json"), (status = 503, body = Problem, content_type = "application/problem+json")))]
async fn contact(
    State(app): State<Arc<App>>,
    Extension(context): Extension<RequestContext>,
    Path(id): Path<String>,
    query: Parameters<SnapshotQuery>,
) -> Response {
    let result = async {
        let query = parsed(query)?;
        check_snapshot(&app, query.snapshot.as_deref())?;
        let contact = selected_contact(&app, id)
            .await
            .map_err(ApiError::from_status)?;
        Ok(ContactResponse {
            data: public_contact(contact, &app),
            meta: snapshot_meta(&app),
        })
    }
    .await;
    match result {
        Ok(value) => axum::Json(value).into_response(),
        Err(error) => failure(error, &context),
    }
}

#[utoipa::path(get, path = "/api/contacts/{id}/vcard", operation_id = "downloadContactVcard", params(("id" = String, Path), SnapshotQuery),
    responses((status = 200, body = String, content_type = "text/vcard"), (status = 400, body = Problem, content_type = "application/problem+json"), (status = 404, body = Problem, content_type = "application/problem+json"), (status = 409, body = Problem, content_type = "application/problem+json"), (status = 503, body = Problem, content_type = "application/problem+json")))]
async fn vcard(
    State(app): State<Arc<App>>,
    Extension(context): Extension<RequestContext>,
    Path(id): Path<String>,
    query: Parameters<SnapshotQuery>,
) -> Response {
    let result = async {
        let query = parsed(query)?;
        check_snapshot(&app, query.snapshot.as_deref())?;
        selected_contact(&app, id)
            .await
            .map_err(ApiError::from_status)
    }
    .await;
    match result {
        Ok(contact) => (
            [
                (header::CONTENT_TYPE, "text/vcard; charset=utf-8"),
                (
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=contact.vcf",
                ),
            ],
            store::vcard(&contact),
        )
            .into_response(),
        Err(error) => failure(error, &context),
    }
}

#[utoipa::path(get, path = "/api/sources", operation_id = "listSources", params(SourcesQuery),
    responses((status = 200, body = SourceCollection), (status = 400, body = Problem, content_type = "application/problem+json"), (status = 409, body = Problem, content_type = "application/problem+json")))]
async fn sources(
    State(app): State<Arc<App>>,
    Extension(context): Extension<RequestContext>,
    query: Parameters<SourcesQuery>,
) -> Response {
    let result = (|| {
        let query = parsed(query)?;
        check_snapshot(&app, query.snapshot.as_deref())?;
        let page = query.page.unwrap_or(1);
        if page == 0 {
            return Err(ApiError::invalid(
                "page",
                "Page numbers start at 1. Follow the returned next link for later pages.",
            ));
        }
        let mut sources: Vec<_> = app.coverage.sources.iter().collect();
        sources.sort_by(|first, second| first.id.cmp(&second.id));
        let total = sources.len();
        let window = PageWindow::new(total, page);
        if window.page() != page {
            return Err(page_out_of_range());
        }
        let data = sources
            .into_iter()
            .skip(window.offset())
            .take(window.length())
            .cloned()
            .collect();
        Ok(SourceCollection {
            data,
            meta: page_meta(&app, total, window),
            links: page_links("/api/sources", &Search::default(), window, &app.snapshot),
        })
    })();
    match result {
        Ok(value) => axum::Json(value).into_response(),
        Err(error) => failure(error, &context),
    }
}

#[utoipa::path(get, path = "/api/sources/{id}", operation_id = "getSource", params(("id" = String, Path), SnapshotQuery),
    responses((status = 200, body = SourceResponse), (status = 400, body = Problem, content_type = "application/problem+json"), (status = 404, body = Problem, content_type = "application/problem+json"), (status = 409, body = Problem, content_type = "application/problem+json")))]
async fn source(
    State(app): State<Arc<App>>,
    Extension(context): Extension<RequestContext>,
    Path(id): Path<String>,
    query: Parameters<SnapshotQuery>,
) -> Response {
    let result = (|| {
        let query = parsed(query)?;
        check_snapshot(&app, query.snapshot.as_deref())?;
        let source = app
            .coverage
            .sources
            .iter()
            .find(|source| source.id == id)
            .cloned()
            .ok_or_else(|| ApiError::from_status(StatusCode::NOT_FOUND))?;
        Ok(SourceResponse {
            data: source,
            meta: snapshot_meta(&app),
        })
    })();
    match result {
        Ok(value) => axum::Json(value).into_response(),
        Err(error) => failure(error, &context),
    }
}

#[utoipa::path(get, path = "/api/catalog", operation_id = "getCatalog", params(SnapshotQuery),
    responses((status = 200, body = CatalogResponse), (status = 400, body = Problem, content_type = "application/problem+json"), (status = 409, body = Problem, content_type = "application/problem+json"), (status = 503, body = Problem, content_type = "application/problem+json")))]
async fn catalog(
    State(app): State<Arc<App>>,
    Extension(context): Extension<RequestContext>,
    query: Parameters<SnapshotQuery>,
) -> Response {
    let result = (|| {
        let query = parsed(query)?;
        check_snapshot(&app, query.snapshot.as_deref())?;
        let municipalities = app
            .municipalities
            .iter()
            .map(|(code, name)| {
                let checked = MunicipalityCode::parse(code.as_bytes())
                    .ok_or_else(|| ApiError::from_status(StatusCode::SERVICE_UNAVAILABLE))?;
                Ok(MunicipalityInfo {
                    code: code.clone(),
                    name: name.clone(),
                    prefecture_code: format!("{:02}", checked.prefecture()),
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?;
        Ok(CatalogResponse {
            data: Catalog {
                contacts: app.coverage.total_contacts,
                unique_phone_numbers: app.coverage.unique_phone_numbers,
                sources: app.coverage.sources.len(),
                categories: Category::ALL
                    .into_iter()
                    .map(|category| CategoryInfo {
                        id: category,
                        name: category.label(),
                        name_ja: super::presentation::category_label(category),
                        attribution: category.attribution(),
                    })
                    .collect(),
                prefectures: app.prefectures.clone(),
                municipalities,
                coverage: app.coverage.cells.clone(),
            },
            meta: snapshot_meta(&app),
        })
    })();
    match result {
        Ok(value) => axum::Json(value).into_response(),
        Err(error) => failure(error, &context),
    }
}

#[utoipa::path(get, path = "/api/export", operation_id = "exportContacts", params(ExportQuery),
    responses((status = 200, content(([ExportRecord] = "application/json"), (String = "text/csv"), (String = "text/vcard"))), (status = 400, body = Problem, content_type = "application/problem+json"), (status = 409, body = Problem, content_type = "application/problem+json"), (status = 503, body = Problem, content_type = "application/problem+json")))]
async fn export_contacts(
    State(app): State<Arc<App>>,
    Extension(context): Extension<RequestContext>,
    query: Parameters<ExportQuery>,
) -> Response {
    let result = async {
        let query = parsed(query)?;
        check_snapshot(&app, query.snapshot.as_deref())?;
        let format = query.format.unwrap_or_default().into();
        let search = checked_search(
            query.q,
            query.prefecture,
            query.municipality,
            query.category,
            1,
        )?;
        super::export_response(&app, search, format, &context)
            .await
            .map_err(ApiError::from_status)
    }
    .await;
    match result {
        Ok(value) => value,
        Err(error) => failure(error, &context),
    }
}

#[derive(OpenApi)]
#[openapi(
    info(title = "Public Phonebook API", version = "unreleased", description = "Public organizational contacts for all 47 Japanese prefectures. No account or API key is required. Each record retains its publisher, reuse terms and source dates. Follow returned snapshot-pinned links, or use bulk exports instead of scraping HTML."),
    paths(index, contacts, contact, vcard, sources, source, catalog, export_contacts),
    servers((url = "/"))
)]
struct ApiDocument;

pub(super) fn document() -> utoipa::openapi::OpenApi {
    ApiDocument::openapi()
}

async fn openapi_spec(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    use sha2::{Digest, Sha256};
    let etag = format!("\"{:x}\"", Sha256::digest(&app.api_document));
    let unchanged = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|part| {
                let part = part.trim().strip_prefix("W/").unwrap_or(part.trim());
                part == etag || part == "*"
            })
        });
    let mut response = if unchanged {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        (
            [(header::CONTENT_TYPE, "application/json")],
            app.api_document.clone(),
        )
            .into_response()
    };
    response
        .headers_mut()
        .insert(header::ETAG, etag.parse().expect("digest header"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("public, max-age=0, must-revalidate"),
    );
    response
}

#[derive(askama::Template)]
#[template(path = "api.html")]
struct ApiPage {
    shell: Shell,
}

async fn docs() -> Response {
    render(ApiPage {
        shell: Shell {
            title: "API",
            on_data: false,
        },
    })
}

pub(super) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api", get(index))
        .route("/api/contacts", get(contacts))
        .route("/api/contacts/{id}", get(contact))
        .route("/api/contacts/{id}/vcard", get(vcard))
        .route("/api/sources", get(sources))
        .route("/api/sources/{id}", get(source))
        .route("/api/catalog", get(catalog))
        .route("/api/export", get(export_contacts))
        .route("/api/openapi.json", get(openapi_spec))
        .route("/api/docs", get(docs))
}
