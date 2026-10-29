use axum::{
    extract::Path,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use sha2::{Digest, Sha256};

fn asset(bytes: &'static [u8], mime: &'static str, headers: HeaderMap) -> Response {
    let etag = format!("\"{:x}\"", Sha256::digest(bytes));
    let unchanged = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|value| {
                let value = value.trim().strip_prefix("W/").unwrap_or(value.trim());
                value == etag || value == "*"
            })
        });
    let mut response = if unchanged {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        ([(header::CONTENT_TYPE, mime)], bytes).into_response()
    };
    response
        .headers_mut()
        .insert(header::ETAG, etag.parse().expect("digest header"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "public, max-age=0, must-revalidate"
            .parse()
            .expect("constant header"),
    );
    response
}

pub(super) async fn style(headers: HeaderMap) -> Response {
    asset(
        include_bytes!("../../../../static/style.css"),
        "text/css; charset=utf-8",
        headers,
    )
}
pub(super) async fn script(headers: HeaderMap) -> Response {
    asset(
        include_bytes!("../../../../static/app.js"),
        "text/javascript; charset=utf-8",
        headers,
    )
}
pub(super) async fn api_script(headers: HeaderMap) -> Response {
    asset(
        include_bytes!("../../../../static/api.js"),
        "text/javascript; charset=utf-8",
        headers,
    )
}
pub(super) async fn font(Path(name): Path<String>, headers: HeaderMap) -> Response {
    match name.as_str() {
        "noto-sans-jp.woff2" => asset(
            include_bytes!("../../../../static/fonts/noto-sans-jp.woff2"),
            "font/woff2",
            headers,
        ),
        "OFL.txt" => asset(
            include_bytes!("../../../../static/fonts/OFL.txt"),
            "text/plain; charset=utf-8",
            headers,
        ),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

pub(super) async fn icon(Path(name): Path<String>, headers: HeaderMap) -> Response {
    let bytes: &'static [u8] = match name.as_str() {
        "search.svg" => include_bytes!("../../../../static/icons/search.svg"),
        "location.svg" => include_bytes!("../../../../static/icons/location.svg"),
        "filters.svg" => include_bytes!("../../../../static/icons/filters.svg"),
        "library.svg" => include_bytes!("../../../../static/icons/library.svg"),
        "phone.svg" => include_bytes!("../../../../static/icons/phone.svg"),
        "save.svg" => include_bytes!("../../../../static/icons/save.svg"),
        "next.svg" => include_bytes!("../../../../static/icons/next.svg"),
        "museum.svg" => include_bytes!("../../../../static/icons/museum.svg"),
        "archive.svg" => include_bytes!("../../../../static/icons/archive.svg"),
        "back.svg" => include_bytes!("../../../../static/icons/back.svg"),
        "external.svg" => include_bytes!("../../../../static/icons/external.svg"),
        "info.svg" => include_bytes!("../../../../static/icons/info.svg"),
        "file.svg" => include_bytes!("../../../../static/icons/file.svg"),
        "alert.svg" => include_bytes!("../../../../static/icons/alert.svg"),
        "retry.svg" => include_bytes!("../../../../static/icons/retry.svg"),
        "download.svg" => include_bytes!("../../../../static/icons/download.svg"),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    asset(bytes, "image/svg+xml", headers)
}
