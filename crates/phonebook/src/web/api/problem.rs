use super::super::RequestContext;
use axum::{
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use phonebook_core::ApiProblemKind;
use serde::{Serialize, Serializer};
use utoipa::{
    PartialSchema, ToSchema,
    openapi::{ObjectBuilder, RefOr, Schema, schema::Type},
};

#[derive(Clone, Copy)]
pub(in crate::web) struct ApiError {
    pub kind: ApiProblemKind,
    pub parameter: Option<&'static str>,
    pub detail: &'static str,
}

impl ApiError {
    pub fn invalid(parameter: &'static str, detail: &'static str) -> Self {
        Self {
            kind: ApiProblemKind::InvalidQuery,
            parameter: Some(parameter),
            detail,
        }
    }

    pub fn from_status(status: StatusCode) -> Self {
        match status {
            StatusCode::BAD_REQUEST => Self::invalid(
                "request",
                "The request contains invalid URL encoding or parameters. See /api/docs for supported requests.",
            ),
            StatusCode::NOT_FOUND => Self {
                kind: ApiProblemKind::NotFound,
                parameter: None,
                detail: "This resource does not exist in the current snapshot. Discover available resources at /api.",
            },
            StatusCode::METHOD_NOT_ALLOWED => Self {
                kind: ApiProblemKind::MethodNotAllowed,
                parameter: None,
                detail: "Use GET or HEAD to read public data. OPTIONS is available for browser preflight requests.",
            },
            StatusCode::CONFLICT => Self {
                kind: ApiProblemKind::SnapshotChanged,
                parameter: None,
                detail: "The active snapshot has changed. Start again from /api and follow its new links to avoid mixing snapshots.",
            },
            _ => Self {
                kind: ApiProblemKind::Unavailable,
                parameter: None,
                detail: "The service is temporarily unavailable. Wait for Retry-After before retrying this request.",
            },
        }
    }
}

pub(super) struct ProblemCode(pub ApiProblemKind);

impl Serialize for ProblemCode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0.code())
    }
}

impl PartialSchema for ProblemCode {
    fn schema() -> RefOr<Schema> {
        ObjectBuilder::new()
            .schema_type(Type::String)
            .enum_values(Some(ApiProblemKind::ALL.map(ApiProblemKind::code)))
            .into()
    }
}

impl ToSchema for ProblemCode {}

#[derive(Serialize, ToSchema)]
pub(super) struct InvalidParameter {
    pub name: &'static str,
    pub reason: &'static str,
}

#[derive(Serialize, ToSchema)]
pub(super) struct Problem {
    #[serde(rename = "type")]
    pub problem_type: String,
    pub title: &'static str,
    pub status: u16,
    pub detail: &'static str,
    pub instance: String,
    pub code: ProblemCode,
    pub request_id: String,
    pub invalid_parameters: Vec<InvalidParameter>,
}

pub(in crate::web) fn failure(error: ApiError, context: &RequestContext) -> Response {
    let kind = error.kind;
    let problem = Problem {
        problem_type: format!("/api/docs#{}", kind.code().replace('_', "-")),
        title: kind.title(),
        status: kind.status(),
        detail: error.detail,
        instance: format!("urn:public-phonebook:request:{}", context.id),
        code: ProblemCode(kind),
        request_id: context.id.clone(),
        invalid_parameters: error
            .parameter
            .map(|name| InvalidParameter {
                name,
                reason: error.detail,
            })
            .into_iter()
            .collect(),
    };
    let mut response = axum::Json(problem).into_response();
    *response.status_mut() = StatusCode::from_u16(kind.status()).expect("proved HTTP status");
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/problem+json"),
    );
    if let Some(seconds) = kind.retry_after() {
        response.headers_mut().insert(
            header::RETRY_AFTER,
            seconds.to_string().parse().expect("integer header"),
        );
    }
    if kind == ApiProblemKind::MethodNotAllowed {
        response.headers_mut().insert(
            header::ALLOW,
            header::HeaderValue::from_static("GET, HEAD, OPTIONS"),
        );
    }
    response
}

pub(in crate::web) fn apply_cors(headers: &mut HeaderMap) {
    for (name, value) in [
        ("access-control-allow-origin", "*"),
        ("access-control-allow-methods", "GET, HEAD, OPTIONS"),
        ("access-control-allow-headers", "Accept, If-None-Match"),
        (
            "access-control-expose-headers",
            "X-Request-Id, X-Public-Phonebook-Snapshot, Retry-After, Content-Disposition, Link, ETag, Allow",
        ),
    ] {
        headers.insert(
            header::HeaderName::from_static(name),
            header::HeaderValue::from_static(value),
        );
    }
}
