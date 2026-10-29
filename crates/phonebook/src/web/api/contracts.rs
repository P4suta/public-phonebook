use crate::model::{Category, Contact, CoverageCell, Prefecture, SourceReport};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

#[derive(Default, Deserialize, IntoParams)]
#[serde(default, deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub(super) struct ContactsQuery {
    /// Name fragment or complete Japanese telephone number, at most 512 UTF-8 bytes.
    pub q: Option<String>,
    #[param(pattern = "^(0[1-9]|[1-3][0-9]|4[0-7])$")]
    pub prefecture: Option<String>,
    /// Five-digit municipality code belonging to the selected prefecture.
    #[param(pattern = "^[0-9]{5}$")]
    pub municipality: Option<String>,
    #[param(value_type = Option<Category>)]
    pub category: Option<String>,
    /// One-based page; use the returned next link or exports for complete results.
    #[param(minimum = 1, default = 1)]
    pub page: Option<usize>,
    /// Optional snapshot pin; a different active snapshot returns 409.
    #[param(pattern = "^[0-9a-f]{64}$")]
    pub snapshot: Option<String>,
}

#[derive(Default, Deserialize, IntoParams)]
#[serde(default, deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub(super) struct SnapshotQuery {
    #[param(pattern = "^[0-9a-f]{64}$")]
    pub snapshot: Option<String>,
}

#[derive(Default, Deserialize, IntoParams)]
#[serde(default, deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub(super) struct SourcesQuery {
    #[param(minimum = 1, default = 1)]
    pub page: Option<usize>,
    #[param(pattern = "^[0-9a-f]{64}$")]
    pub snapshot: Option<String>,
}

#[derive(Clone, Copy, Default, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub(super) enum DownloadFormat {
    #[default]
    Json,
    Csv,
    Vcf,
}

impl From<DownloadFormat> for phonebook_core::ExportFormat {
    fn from(value: DownloadFormat) -> Self {
        match value {
            DownloadFormat::Json => Self::Json,
            DownloadFormat::Csv => Self::Csv,
            DownloadFormat::Vcf => Self::Vcf,
        }
    }
}

#[derive(Default, Deserialize, IntoParams)]
#[serde(default, deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub(super) struct ExportQuery {
    pub q: Option<String>,
    #[param(pattern = "^(0[1-9]|[1-3][0-9]|4[0-7])$")]
    pub prefecture: Option<String>,
    #[param(pattern = "^[0-9]{5}$")]
    pub municipality: Option<String>,
    #[param(value_type = Option<Category>)]
    pub category: Option<String>,
    #[param(default = "json")]
    pub format: Option<DownloadFormat>,
    #[param(pattern = "^[0-9a-f]{64}$")]
    pub snapshot: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub(super) struct SnapshotMeta {
    #[schema(pattern = "^[0-9a-f]{64}$")]
    pub snapshot: String,
    pub generated_at: String,
}

#[derive(Serialize, ToSchema)]
pub(super) struct PageMeta {
    #[serde(flatten)]
    pub snapshot: SnapshotMeta,
    pub page: usize,
    pub page_size: usize,
    pub total: usize,
    pub total_pages: usize,
}

#[derive(Serialize, ToSchema)]
pub(super) struct PageLinks {
    #[serde(rename = "self")]
    pub self_url: String,
    pub first: String,
    pub previous: Option<String>,
    pub next: Option<String>,
    pub last: String,
}

#[derive(Serialize, ToSchema)]
pub(super) struct DownloadLinks {
    pub json: String,
    pub csv: String,
    pub vcf: String,
}

#[derive(Serialize, ToSchema)]
pub(super) struct ContactLinks {
    #[serde(rename = "self")]
    pub self_url: String,
    pub source: String,
    pub web: String,
    pub vcard: String,
}

#[derive(Serialize, ToSchema)]
pub(super) struct PublicContact {
    #[serde(flatten)]
    pub contact: Contact,
    pub attribution: String,
    pub links: ContactLinks,
}

#[derive(Serialize, ToSchema)]
pub(super) struct ContactCollection {
    pub data: Vec<PublicContact>,
    pub meta: PageMeta,
    pub links: PageLinks,
    pub exports: DownloadLinks,
}

#[derive(Serialize, ToSchema)]
pub(super) struct ContactResponse {
    pub data: PublicContact,
    pub meta: SnapshotMeta,
}

#[derive(Serialize, ToSchema)]
pub(super) struct SourceCollection {
    pub data: Vec<SourceReport>,
    pub meta: PageMeta,
    pub links: PageLinks,
}

#[derive(Serialize, ToSchema)]
pub(super) struct SourceResponse {
    pub data: SourceReport,
    pub meta: SnapshotMeta,
}

#[derive(Serialize, ToSchema)]
pub(super) struct CategoryInfo {
    pub id: Category,
    pub name: &'static str,
    pub name_ja: &'static str,
    pub attribution: &'static str,
}

#[derive(Serialize, ToSchema)]
pub(super) struct MunicipalityInfo {
    pub code: String,
    pub name: String,
    pub prefecture_code: String,
}

#[derive(Serialize, ToSchema)]
pub(super) struct Catalog {
    pub contacts: usize,
    pub unique_phone_numbers: usize,
    pub sources: usize,
    pub categories: Vec<CategoryInfo>,
    pub prefectures: Vec<Prefecture>,
    pub municipalities: Vec<MunicipalityInfo>,
    pub coverage: Vec<CoverageCell>,
}

#[derive(Serialize, ToSchema)]
pub(super) struct CatalogResponse {
    pub data: Catalog,
    pub meta: SnapshotMeta,
}

#[derive(Serialize, ToSchema)]
pub(super) struct Endpoints {
    pub contacts: String,
    pub sources: String,
    pub catalog: String,
    pub exports: DownloadLinks,
    pub documentation: &'static str,
    pub openapi: &'static str,
}

#[derive(Serialize, ToSchema)]
pub(super) struct Discovery {
    pub data: Endpoints,
    pub meta: SnapshotMeta,
}

pub(super) type ExportRecord = crate::store::ExportContact<'static>;
