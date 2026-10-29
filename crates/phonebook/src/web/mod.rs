mod api;
mod assets;
mod presentation;
mod stream;

use crate::{model::*, snapshot, store};
use anyhow::{Context, Result, ensure};
use askama::Template;
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Query, Request, State, rejection::QueryRejection},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use presentation::{category_icon, category_label, count, date_label, publisher};
use serde::Serialize;
use std::{
    io::Write,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::sync::{Semaphore, mpsc, oneshot};

const DEFAULT_SEARCH_PERMITS: usize = 4;
const MAX_SEARCH_PERMITS: usize = 64;
const MAX_EXPORT_PERMITS: usize = 8;
const MAX_CONTACT_IDENTIFIER_BYTES: usize = 256;
const MAX_REQUEST_TARGET_BYTES: usize = 8192;

#[derive(Clone, Copy)]
pub struct ServiceLimits {
    pub searches: usize,
    pub exports: usize,
}

impl Default for ServiceLimits {
    fn default() -> Self {
        Self {
            searches: DEFAULT_SEARCH_PERMITS,
            exports: 2,
        }
    }
}

struct App {
    database: PathBuf,
    coverage: Coverage,
    snapshot: String,
    api_document: axum::body::Bytes,
    request_prefix: String,
    sequence: AtomicU64,
    prefectures: Vec<Prefecture>,
    municipalities: Vec<(String, String)>,
    catalog: Vec<DataRow>,
    searches: Arc<Semaphore>,
    exports: Arc<Semaphore>,
}

#[derive(Clone)]
struct RequestContext {
    id: String,
}

struct Shell {
    title: &'static str,
    on_data: bool,
}

#[derive(Template)]
#[template(path = "index.html")]
struct Page {
    shell: Shell,
    result: SearchResult,
    query: Search,
    snapshot: String,
    prefectures: Vec<Prefecture>,
    municipalities: Vec<(String, String)>,
    categories: Vec<(String, String)>,
    export_query: String,
    previous: String,
    next: String,
    cards: Vec<Card>,
    total_label: String,
    shown_label: String,
}

#[derive(Template)]
#[template(path = "cards.html")]
struct CardsPage {
    cards: Vec<Card>,
}

struct Card {
    id: String,
    name: String,
    category: &'static str,
    icon: &'static str,
    prefecture: String,
    municipality: String,
    address: String,
    phones: Vec<Phone>,
    detail_url: String,
}

#[derive(Template)]
#[template(path = "contact.html")]
struct ContactPage {
    shell: Shell,
    card: Card,
    back_url: String,
    source_url: String,
    official_url: String,
    publisher: presentation::Publisher,
    source_date: String,
}

#[derive(Template)]
#[template(path = "source.html")]
struct SourcePage {
    shell: Shell,
    contact: Contact,
    publisher: presentation::Publisher,
    listing_url: String,
    original_url: String,
    original_format: &'static str,
    license_url: String,
    back_url: String,
    retrieved_date: String,
    source_date: String,
    attribution: &'static str,
    source: SourceReport,
    snapshot: String,
}

#[derive(Clone)]
struct DataRow {
    category: &'static str,
    publisher: &'static str,
    license: String,
    license_url: String,
    contacts: String,
    empty_prefectures: usize,
}

#[derive(Template)]
#[template(path = "data.html")]
struct DataPage {
    shell: Shell,
    contacts: String,
    date: String,
    snapshot: String,
    catalog: Vec<DataRow>,
}

#[derive(Template)]
#[template(path = "error.html")]
struct ErrorPage {
    shell: Shell,
    title: &'static str,
    message: &'static str,
    request_id: String,
}

type SearchQuery = Result<Query<Search>, QueryRejection>;

fn query_string(query: &Search) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer
        .append_pair("q", &query.q)
        .append_pair("prefecture", &query.prefecture)
        .append_pair("municipality", &query.municipality)
        .append_pair("category", &query.category);
    serializer.finish()
}

fn results_url(query: &Search) -> String {
    format!("/?{}&page={}", query_string(query), query.page.max(1))
}

fn render(template: impl Template) -> Response {
    match template.render() {
        Ok(html) => Html(html).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "ページを表示できませんでした。",
        )
            .into_response(),
    }
}

fn failure(status: StatusCode, context: &RequestContext) -> Response {
    let (title, message) = match status {
        StatusCode::BAD_REQUEST => (
            "この検索は できません",
            "入力した条件が正しくありません。都道府県・種類・ページを確認してください。",
        ),
        StatusCode::NOT_FOUND => (
            "このページは 見つかりません",
            "連絡先が見つからないか、ページの場所が変わっています。",
        ),
        StatusCode::METHOD_NOT_ALLOWED => (
            "この操作は できません",
            "このサービスでは検索と公開データの保存ができます。",
        ),
        _ => (
            "読みこめませんでした",
            "処理が混み合っているか、一時的にデータを読みこめません。時間をおいてもう一度お試しください。",
        ),
    };
    let mut response = render(ErrorPage {
        shell: Shell {
            title,
            on_data: false,
        },
        title,
        message,
        request_id: context.id.clone(),
    });
    *response.status_mut() = status;
    if status == StatusCode::SERVICE_UNAVAILABLE {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, "1".parse().expect("constant header"));
    }
    response
}

fn checked_query(query: SearchQuery) -> Result<Search, StatusCode> {
    match query {
        Ok(Query(query)) if query.validate().is_ok() => Ok(query),
        _ => Err(StatusCode::BAD_REQUEST),
    }
}

fn file_format(value: &str) -> Option<&'static str> {
    let url = url::Url::parse(value).ok()?;
    match url.path().rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "xlsx" => Some("XLSX"),
        "xls" => Some("XLS"),
        "xlsm" => Some("XLSM"),
        "zip" => Some("ZIP"),
        "pdf" => Some("PDF"),
        "csv" => Some("CSV"),
        "json" => Some("JSON"),
        _ => None,
    }
}

fn safe_url(value: &str) -> String {
    store::web_url(value).unwrap_or_default()
}

fn card(app: &App, contact: &Contact, query: &Search) -> Card {
    let municipality = contact
        .municipality_code
        .as_ref()
        .and_then(|code| app.municipalities.iter().find(|(known, _)| known == code))
        .map(|(_, name)| name.strip_prefix(&contact.prefecture).unwrap_or(name))
        .map(|name| {
            name.strip_suffix("役所")
                .or_else(|| name.strip_suffix("役場"))
                .unwrap_or(name)
        })
        .unwrap_or_default()
        .to_owned();
    Card {
        id: contact.id.clone(),
        name: contact.name.clone(),
        category: category_label(contact.category),
        icon: category_icon(contact.category),
        prefecture: contact.prefecture.clone(),
        municipality,
        address: contact.address.clone(),
        phones: contact.phones.clone(),
        detail_url: format!(
            "/contacts/{}?{}&page={}",
            contact.id,
            query_string(query),
            query.page.max(1)
        ),
    }
}

async fn lookup(app: &App, query: &Search) -> Result<SearchResult, StatusCode> {
    let permit = app
        .searches
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let database = app.database.clone();
    let query = query.clone();
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        store::search(&database, &query, true)
    })
    .await
    {
        Ok(Ok(result)) => Ok(result),
        _ => Err(StatusCode::SERVICE_UNAVAILABLE),
    }
}

async fn index(
    State(app): State<Arc<App>>,
    Extension(context): Extension<RequestContext>,
    query: SearchQuery,
) -> Response {
    let query = match checked_query(query) {
        Ok(query) => query,
        Err(status) => return failure(status, &context),
    };
    let result = match lookup(&app, &query).await {
        Ok(result) => result,
        Err(status) => return failure(status, &context),
    };
    let mut effective_query = query.clone();
    effective_query.page = result.page;
    let export_query = query_string(&query);
    let previous = format!(
        "/?{export_query}&page={}",
        result.page.saturating_sub(1).max(1)
    );
    let next = format!("/?{export_query}&page={}", result.page + 1);
    let cards = result
        .contacts
        .iter()
        .map(|contact| card(&app, contact, &effective_query))
        .collect();
    let window = phonebook_core::PageWindow::new(result.total, result.page);
    let page = Page {
        shell: Shell {
            title: "電話番号をさがす",
            on_data: false,
        },
        total_label: count(result.total),
        shown_label: count(window.offset() + window.length()),
        result,
        query: query.clone(),
        snapshot: app.snapshot.clone(),
        prefectures: app.prefectures.clone(),
        municipalities: app.municipalities.clone(),
        categories: Category::ALL
            .into_iter()
            .map(|category| (category.key().into(), category_label(category).into()))
            .collect(),
        export_query,
        previous,
        next,
        cards,
    };
    render(page)
}

#[derive(Serialize)]
struct FeedPage {
    snapshot: String,
    total: usize,
    page: usize,
    pages: usize,
    shown: usize,
    html: String,
}

async fn feed(
    State(app): State<Arc<App>>,
    Extension(context): Extension<RequestContext>,
    query: SearchQuery,
) -> Response {
    let query = match checked_query(query) {
        Ok(query) => query,
        Err(status) => return failure(status, &context),
    };
    let result = match lookup(&app, &query).await {
        Ok(result) => result,
        Err(status) => return failure(status, &context),
    };
    let mut query = query;
    query.page = result.page;
    let cards = CardsPage {
        cards: result
            .contacts
            .iter()
            .map(|contact| card(&app, contact, &query))
            .collect(),
    };
    let html = match cards.render() {
        Ok(html) => html,
        Err(_) => return failure(StatusCode::INTERNAL_SERVER_ERROR, &context),
    };
    let window = phonebook_core::PageWindow::new(result.total, result.page);
    axum::Json(FeedPage {
        snapshot: app.snapshot.clone(),
        total: result.total,
        page: result.page,
        pages: result.pages,
        shown: window.offset() + window.length(),
        html,
    })
    .into_response()
}

async fn selected_contact(app: &App, id: String) -> Result<Contact, StatusCode> {
    if id.is_empty() || id.len() > MAX_CONTACT_IDENTIFIER_BYTES {
        return Err(StatusCode::NOT_FOUND);
    }
    let permit = app
        .searches
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let database = app.database.clone();
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        store::contact(&database, &id)
    })
    .await
    {
        Ok(Ok(contact)) => Ok(contact),
        Ok(Err(error))
            if error
                .downcast_ref::<rusqlite::Error>()
                .is_some_and(|error| matches!(error, rusqlite::Error::QueryReturnedNoRows)) =>
        {
            Err(StatusCode::NOT_FOUND)
        }
        _ => Err(StatusCode::SERVICE_UNAVAILABLE),
    }
}

async fn contact_view(
    State(app): State<Arc<App>>,
    Extension(context): Extension<RequestContext>,
    Path(id): Path<String>,
    query: SearchQuery,
) -> Response {
    let query = match checked_query(query) {
        Ok(query) => query,
        Err(status) => return failure(status, &context),
    };
    if let Some(id) = id.strip_suffix(".vcf") {
        return single_contact(&app, id.to_owned(), &context).await;
    }
    let contact = match selected_contact(&app, id).await {
        Ok(contact) => contact,
        Err(status) => return failure(status, &context),
    };
    render(ContactPage {
        shell: Shell {
            title: "連絡先",
            on_data: false,
        },
        card: card(&app, &contact, &query),
        back_url: results_url(&query),
        source_url: format!(
            "/contacts/{}/source?{}&page={}",
            contact.id,
            query_string(&query),
            query.page.max(1)
        ),
        official_url: safe_url(contact.official_url.as_deref().unwrap_or_default()),
        publisher: publisher(contact.category),
        source_date: date_label(&contact.data_as_of),
    })
}

async fn source_details(
    State(app): State<Arc<App>>,
    Extension(context): Extension<RequestContext>,
    Path(id): Path<String>,
    query: SearchQuery,
) -> Response {
    let query = match checked_query(query) {
        Ok(query) => query,
        Err(status) => return failure(status, &context),
    };
    let contact = match selected_contact(&app, id).await {
        Ok(contact) => contact,
        Err(status) => return failure(status, &context),
    };
    let Some(source) = app
        .coverage
        .sources
        .iter()
        .find(|source| source.id == contact.source_id)
    else {
        return failure(StatusCode::SERVICE_UNAVAILABLE, &context);
    };
    let listing_url = [&source.index_url, &contact.source_url]
        .into_iter()
        .filter_map(|value| store::web_url(value))
        .find(|value| file_format(value).is_none())
        .unwrap_or_default();
    let original = [&contact.source_url, &source.url]
        .into_iter()
        .filter_map(|value| store::web_url(value))
        .find_map(|value| file_format(&value).map(|format| (value, format)));
    let (original_url, original_format) = original.unwrap_or_default();
    render(SourcePage {
        shell: Shell {
            title: "この番号の出典",
            on_data: false,
        },
        publisher: publisher(contact.category),
        listing_url,
        original_url,
        original_format,
        license_url: safe_url(&contact.license_url),
        back_url: format!(
            "/contacts/{}?{}&page={}",
            contact.id,
            query_string(&query),
            query.page.max(1)
        ),
        retrieved_date: contact
            .retrieved_at
            .split('T')
            .next()
            .unwrap_or_default()
            .into(),
        source_date: date_label(&contact.data_as_of),
        attribution: contact.category.attribution(),
        source: source.clone(),
        snapshot: app.snapshot.clone(),
        contact,
    })
}

async fn data_page(State(app): State<Arc<App>>) -> Response {
    render(DataPage {
        shell: Shell {
            title: "データと出典",
            on_data: true,
        },
        contacts: count(app.coverage.total_contacts),
        date: app
            .coverage
            .generated_at
            .split('T')
            .next()
            .unwrap_or_default()
            .into(),
        snapshot: app.snapshot.clone(),
        catalog: app.catalog.clone(),
    })
}

async fn download(
    State(app): State<Arc<App>>,
    Extension(context): Extension<RequestContext>,
    query: SearchQuery,
) -> Response {
    let query = match checked_query(query) {
        Ok(query) => query,
        Err(status) => return failure(status, &context),
    };
    let format = match query.checked() {
        Ok(query) => query.format().unwrap_or(phonebook_core::ExportFormat::Json),
        Err(_) => return failure(StatusCode::BAD_REQUEST, &context),
    };
    match export_response(&app, query, format, &context).await {
        Ok(response) => response,
        Err(status) => failure(status, &context),
    }
}

async fn export_response(
    app: &App,
    query: Search,
    format: phonebook_core::ExportFormat,
    context: &RequestContext,
) -> Result<Response, StatusCode> {
    let permit = Arc::new(
        app.exports
            .clone()
            .try_acquire_owned()
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?,
    );
    let database = app.database.clone();
    let (sender, receiver) = mpsc::channel(2);
    let (ready_sender, ready_receiver) = oneshot::channel();
    let selected = format;
    let request_id = context.id.clone();
    let worker_permit = permit.clone();
    let mime = selected.mime();
    tokio::task::spawn_blocking(move || {
        let _permit = worker_permit;
        let mut writer = stream::StreamWriter::new(sender.clone(), ready_sender);
        if store::write_export_as(&database, &query, selected, &mut writer)
            .and_then(|_| writer.flush().map_err(Into::into))
            .is_err()
        {
            let delivery =
                match sender.blocking_send(Err(std::io::Error::other("Export interrupted"))) {
                    Ok(()) => "notified",
                    Err(_) => "client_disconnected",
                };
            eprintln!(
                "{}",
                serde_json::json!({"operation":"export", "outcome":"interrupted", "delivery":delivery, "request_id":request_id})
            );
        }
    });
    ready_receiver
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(StreamReader {
        receiver,
        remaining: axum::body::Bytes::new(),
        _permit: permit,
    }));
    Ok((
        [
            (header::CONTENT_TYPE, mime.to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=contacts.{}", format.extension()),
            ),
        ],
        body,
    )
        .into_response())
}

struct StreamReader {
    receiver: mpsc::Receiver<Result<axum::body::Bytes, std::io::Error>>,
    remaining: axum::body::Bytes,
    _permit: Arc<tokio::sync::OwnedSemaphorePermit>,
}

impl tokio::io::AsyncRead for StreamReader {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if buffer.remaining() == 0 {
            return std::task::Poll::Ready(Ok(()));
        }
        let this = self.get_mut();
        if this.remaining.is_empty() {
            match this.receiver.poll_recv(cx) {
                std::task::Poll::Ready(Some(Ok(bytes))) => this.remaining = bytes,
                std::task::Poll::Ready(Some(Err(error))) => {
                    return std::task::Poll::Ready(Err(error));
                }
                std::task::Poll::Ready(None) => return std::task::Poll::Ready(Ok(())),
                std::task::Poll::Pending => return std::task::Poll::Pending,
            }
        }
        let count = buffer.remaining().min(this.remaining.len());
        buffer.put_slice(&this.remaining.split_to(count));
        std::task::Poll::Ready(Ok(()))
    }
}

async fn single_contact(app: &App, id: String, context: &RequestContext) -> Response {
    match selected_contact(app, id).await {
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
        Err(status) => failure(status, context),
    }
}

async fn protect(State(app): State<Arc<App>>, mut request: Request, next: Next) -> Response {
    let started = Instant::now();
    let number = app
        .sequence
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        });
    let context = RequestContext {
        id: format!("{}-{:016x}", app.request_prefix, number.unwrap_or(u64::MAX)),
    };
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|path| path.as_str().to_owned())
        .unwrap_or_else(|| "not_found".into());
    request.extensions_mut().insert(context.clone());
    let public_api = api::is_public(request.uri().path());
    let head = request.method() == axum::http::Method::HEAD;
    let reject = |status| {
        if public_api {
            api::failure(api::ApiError::from_status(status), &context)
        } else {
            failure(status, &context)
        }
    };
    let mut response =
        if number.is_err() || request.uri().to_string().len() > MAX_REQUEST_TARGET_BYTES {
            reject(if number.is_err() {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            })
        } else if public_api && request.method() == axum::http::Method::OPTIONS {
            StatusCode::NO_CONTENT.into_response()
        } else if public_api
            && !matches!(
                *request.method(),
                axum::http::Method::GET | axum::http::Method::HEAD
            )
        {
            reject(StatusCode::METHOD_NOT_ALLOWED)
        } else {
            next.run(request).await
        };
    if public_api && (response.status().is_client_error() || response.status().is_server_error()) {
        if response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .is_none_or(|value| {
                !value
                    .trim()
                    .eq_ignore_ascii_case("application/problem+json")
            })
        {
            response = reject(response.status());
        }
    } else if response.status() == StatusCode::METHOD_NOT_ALLOWED {
        response = reject(StatusCode::METHOD_NOT_ALLOWED);
    }
    if head {
        *response.body_mut() = axum::body::Body::empty();
    }
    let headers = response.headers_mut();
    if public_api {
        api::apply_cors(headers);
    }
    for (name, value) in [
        (
            "content-security-policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
        ),
        ("referrer-policy", "no-referrer"),
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        (
            "permissions-policy",
            "camera=(), microphone=(), geolocation=()",
        ),
    ] {
        headers.insert(
            header::HeaderName::from_static(name),
            header::HeaderValue::from_static(value),
        );
    }
    if !headers.contains_key(header::CACHE_CONTROL) {
        headers.insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        );
    }
    headers.insert(
        "x-public-phonebook-snapshot",
        app.snapshot.parse().expect("digest header"),
    );
    headers.insert(
        "x-request-id",
        context.id.parse().expect("generated request header"),
    );
    eprintln!(
        "{}",
        serde_json::json!({"operation":"http", "route":route, "status":response.status().as_u16(), "request_id":context.id, "snapshot":app.snapshot, "duration_us":started.elapsed().as_micros()})
    );
    response
}

pub fn router(database: PathBuf) -> Result<Router> {
    router_with_limits(database, ServiceLimits::default())
}

pub fn router_with_limits(database: PathBuf, limits: ServiceLimits) -> Result<Router> {
    ensure!(
        (1..=MAX_SEARCH_PERMITS).contains(&limits.searches)
            && (1..=MAX_EXPORT_PERMITS).contains(&limits.exports),
        "Invalid service limits"
    );
    let coverage = store::load_coverage(&database)?;
    ensure!(coverage.complete, "Incomplete snapshot");
    let snapshot = snapshot::digest(&database)?;
    snapshot::verify_manifest(&database, &coverage, &snapshot)?;
    let mut prefectures = Vec::new();
    for cell in &coverage.cells {
        if !prefectures
            .iter()
            .any(|known: &Prefecture| known.code == cell.prefecture_code)
        {
            prefectures.push(Prefecture {
                code: cell.prefecture_code.clone(),
                name: cell.prefecture.clone(),
            });
        }
    }
    let mut catalog = Vec::new();
    for category in Category::ALL {
        let query = Search {
            category: category.key().into(),
            ..Default::default()
        };
        let sample = store::search(&database, &query, true)?
            .contacts
            .into_iter()
            .next();
        let contacts = coverage
            .cells
            .iter()
            .filter(|cell| cell.category == category)
            .map(|cell| cell.contacts)
            .sum();
        let empty_prefectures = coverage
            .cells
            .iter()
            .filter(|cell| cell.category == category && cell.contacts == 0)
            .count();
        catalog.push(DataRow {
            category: category_label(category),
            publisher: publisher(category).name,
            license: sample
                .as_ref()
                .map(|contact| contact.license.clone())
                .unwrap_or_else(|| "掲載なし".into()),
            license_url: sample
                .as_ref()
                .map(|contact| safe_url(&contact.license_url))
                .unwrap_or_default(),
            contacts: count(contacts),
            empty_prefectures,
        });
    }
    let mut random = [0u8; 16];
    getrandom::fill(&mut random)
        .map_err(|_| anyhow::anyhow!("Request identity initialization failed"))?;
    let app = Arc::new(App {
        api_document: serde_json::to_vec(&api::document())?.into(),
        snapshot,
        database: database.clone(),
        coverage,
        request_prefix: random.iter().map(|byte| format!("{byte:02x}")).collect(),
        sequence: AtomicU64::new(1),
        municipalities: store::municipalities(&database)?,
        prefectures,
        catalog,
        searches: Arc::new(Semaphore::new(limits.searches)),
        exports: Arc::new(Semaphore::new(limits.exports)),
    });
    Ok(Router::new().merge(api::routes())
        .route("/", get(index)).route("/data", get(data_page)).route("/internal/search", get(feed))
        .route("/export", get(download)).route("/contacts/{id}", get(contact_view))
        .route("/contacts/{id}/source", get(source_details))
        .route("/coverage.json", get(|State(app): State<Arc<App>>| async move { axum::Json(app.coverage.clone()) }))
        .route("/healthz", get(|State(app): State<Arc<App>>| async move { axum::Json(serde_json::json!({"status":"ok", "snapshot":app.snapshot, "contacts":app.coverage.total_contacts})) }))
        .route("/style.css", get(assets::style)).route("/app.js", get(assets::script)).route("/api.js", get(assets::api_script))
        .route("/icons/{name}", get(assets::icon)).route("/fonts/{name}", get(assets::font))
        .fallback(|Extension(context): Extension<RequestContext>| async move { failure(StatusCode::NOT_FOUND, &context) })
        .layer(middleware::from_fn_with_state(app.clone(), protect)).with_state(app))
}

pub fn api_schema() -> utoipa::openapi::OpenApi {
    api::document()
}

pub async fn serve(directory: PathBuf, port: u16) -> Result<()> {
    serve_at(
        directory,
        std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port)),
    )
    .await
}

pub async fn serve_at(directory: PathBuf, address: std::net::SocketAddr) -> Result<()> {
    serve_snapshot(directory, address, false).await
}

pub async fn serve_snapshot(
    directory: PathBuf,
    address: std::net::SocketAddr,
    require_manifest: bool,
) -> Result<()> {
    let _lock =
        crate::import::lock(&directory, false).context("Acquire the service snapshot lease")?;
    ensure!(
        !require_manifest || directory.join("snapshot.json").is_file(),
        "Service snapshot manifest is required"
    );
    let app = router(directory.join("phonebook.sqlite"))?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("Public Phonebook: http://{}", listener.local_addr()?);
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        if let Ok(mut termination) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = termination.recv() => {} }
            return;
        }
    }
    if tokio::signal::ctrl_c().await.is_err() {
        eprintln!(
            "{}",
            serde_json::json!({"operation":"shutdown", "outcome":"signal_unavailable"})
        );
    }
}
