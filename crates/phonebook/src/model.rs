use serde::{Deserialize, Serialize};

pub const PREFECTURE_COUNT: usize = 47;
pub const MUNICIPALITY_CODE_LENGTH: usize = 5;
pub const SEARCH_QUERY_MAX_BYTES: usize = 512;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, utoipa::ToSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Medical,
    Dental,
    Pharmacy,
    MunicipalOffice,
    PrefecturalOffice,
    NursingCare,
    DisabilitySupport,
    Library,
    Museum,
    Archive,
    Nursery,
    Kindergarten,
    CertifiedChildCenter,
    SmallScaleChildcare,
    WorkplaceChildcare,
    UnlicensedChildcare,
    University,
    JuniorCollege,
    TechnicalCollege,
    ConsumerAffairs,
    LabourBureau,
    LabourInspection,
    LabourConsultation,
    ChildConsultation,
    SocialWithdrawalSupport,
    PensionOffice,
    PensionConsultation,
    TaxOffice,
    LegalAffairs,
    FireBrigadeOffice,
    PoliceConsultation,
    EmploymentOffice,
    ParentEmploymentSupport,
    GraduateEmploymentSupport,
    YouthEmploymentSupport,
    ForeignEmploymentSupport,
    LocalEmploymentSupport,
    AgricultureEmploymentSupport,
    RelocationEmploymentSupport,
}

impl Category {
    pub const ALL: [Self; 39] = [
        Self::Medical,
        Self::Dental,
        Self::Pharmacy,
        Self::MunicipalOffice,
        Self::PrefecturalOffice,
        Self::NursingCare,
        Self::DisabilitySupport,
        Self::Library,
        Self::Museum,
        Self::Archive,
        Self::Nursery,
        Self::Kindergarten,
        Self::CertifiedChildCenter,
        Self::SmallScaleChildcare,
        Self::WorkplaceChildcare,
        Self::UnlicensedChildcare,
        Self::University,
        Self::JuniorCollege,
        Self::TechnicalCollege,
        Self::ConsumerAffairs,
        Self::LabourBureau,
        Self::LabourInspection,
        Self::LabourConsultation,
        Self::ChildConsultation,
        Self::SocialWithdrawalSupport,
        Self::PensionOffice,
        Self::PensionConsultation,
        Self::TaxOffice,
        Self::LegalAffairs,
        Self::FireBrigadeOffice,
        Self::PoliceConsultation,
        Self::EmploymentOffice,
        Self::ParentEmploymentSupport,
        Self::GraduateEmploymentSupport,
        Self::YouthEmploymentSupport,
        Self::ForeignEmploymentSupport,
        Self::LocalEmploymentSupport,
        Self::AgricultureEmploymentSupport,
        Self::RelocationEmploymentSupport,
    ];
    pub fn key(self) -> &'static str {
        match self {
            Self::Medical => "medical",
            Self::Dental => "dental",
            Self::Pharmacy => "pharmacy",
            Self::MunicipalOffice => "municipal_office",
            Self::PrefecturalOffice => "prefectural_office",
            Self::NursingCare => "nursing_care",
            Self::DisabilitySupport => "disability_support",
            Self::Library => "library",
            Self::Museum => "museum",
            Self::Archive => "archive",
            Self::Nursery => "nursery",
            Self::Kindergarten => "kindergarten",
            Self::CertifiedChildCenter => "certified_child_center",
            Self::SmallScaleChildcare => "small_scale_childcare",
            Self::WorkplaceChildcare => "workplace_childcare",
            Self::UnlicensedChildcare => "unlicensed_childcare",
            Self::University => "university",
            Self::JuniorCollege => "junior_college",
            Self::TechnicalCollege => "technical_college",
            Self::ConsumerAffairs => "consumer_affairs",
            Self::LabourBureau => "labour_bureau",
            Self::LabourInspection => "labour_inspection",
            Self::LabourConsultation => "labour_consultation",
            Self::ChildConsultation => "child_consultation",
            Self::SocialWithdrawalSupport => "social_withdrawal_support",
            Self::PensionOffice => "pension_office",
            Self::PensionConsultation => "pension_consultation",
            Self::TaxOffice => "tax_office",
            Self::LegalAffairs => "legal_affairs",
            Self::FireBrigadeOffice => "fire_brigade_office",
            Self::PoliceConsultation => "police_consultation",
            Self::EmploymentOffice => "employment_office",
            Self::ParentEmploymentSupport => "parent_employment_support",
            Self::GraduateEmploymentSupport => "graduate_employment_support",
            Self::YouthEmploymentSupport => "youth_employment_support",
            Self::ForeignEmploymentSupport => "foreign_employment_support",
            Self::LocalEmploymentSupport => "local_employment_support",
            Self::AgricultureEmploymentSupport => "agriculture_employment_support",
            Self::RelocationEmploymentSupport => "relocation_employment_support",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Medical => "Medical",
            Self::Dental => "Dental",
            Self::Pharmacy => "Pharmacy",
            Self::MunicipalOffice => "Municipal office",
            Self::PrefecturalOffice => "Prefectural office",
            Self::NursingCare => "Nursing care",
            Self::DisabilitySupport => "Disability support",
            Self::Library => "Library",
            Self::Museum => "Museum",
            Self::Archive => "Archive",
            Self::Nursery => "Nursery",
            Self::Kindergarten => "Kindergarten",
            Self::CertifiedChildCenter => "Certified child center",
            Self::SmallScaleChildcare => "Small-scale childcare",
            Self::WorkplaceChildcare => "Workplace childcare",
            Self::UnlicensedChildcare => "Unlicensed childcare",
            Self::University => "University",
            Self::JuniorCollege => "Junior college",
            Self::TechnicalCollege => "Technical college",
            Self::ConsumerAffairs => "Consumer affairs consultation",
            Self::LabourBureau => "Labour bureau",
            Self::LabourInspection => "Labour standards inspection office",
            Self::LabourConsultation => "Labour consultation",
            Self::ChildConsultation => "Child guidance center",
            Self::SocialWithdrawalSupport => "Social withdrawal support",
            Self::PensionOffice => "Pension office",
            Self::PensionConsultation => "Pension consultation center",
            Self::TaxOffice => "Tax office",
            Self::LegalAffairs => "Legal affairs bureau",
            Self::FireBrigadeOffice => "Fire brigade administration",
            Self::PoliceConsultation => "Police consultation",
            Self::EmploymentOffice => "Hello Work",
            Self::ParentEmploymentSupport => "Employment support for parents",
            Self::GraduateEmploymentSupport => "Employment support for graduates",
            Self::YouthEmploymentSupport => "Employment support for young people",
            Self::ForeignEmploymentSupport => "Employment support for foreign residents",
            Self::LocalEmploymentSupport => "Local employment consultation",
            Self::AgricultureEmploymentSupport => "Agriculture, forestry and fisheries employment",
            Self::RelocationEmploymentSupport => "Employment relocation support",
        }
    }

    pub fn nationwide_required(self) -> bool {
        matches!(
            self,
            Self::Medical
                | Self::Dental
                | Self::Pharmacy
                | Self::MunicipalOffice
                | Self::PrefecturalOffice
                | Self::NursingCare
                | Self::DisabilitySupport
                | Self::Library
        )
    }

    pub fn attribution(self) -> &'static str {
        match self {
            Self::NursingCare => {
                "Ministry of Health, Labour and Welfare, Nursing Care Service Information Publication System open data; adapted by Public Phonebook"
            }
            Self::DisabilitySupport => {
                "WAM NET, Disability Welfare Service Information Publication System open data; adapted by Public Phonebook"
            }
            Self::Library | Self::Museum | Self::Archive => {
                "National Diet Library, ISIL institution register; adapted by Public Phonebook"
            }
            Self::Nursery
            | Self::Kindergarten
            | Self::CertifiedChildCenter
            | Self::SmallScaleChildcare
            | Self::WorkplaceChildcare
            | Self::UnlicensedChildcare => {
                "Children and Families Agency / WAM NET, Child and Child-Rearing Support Information Publication System; adapted by Public Phonebook"
            }
            Self::University | Self::JuniorCollege | Self::TechnicalCollege => {
                "Ministry of Education, Culture, Sports, Science and Technology, national higher education institution lists; adapted by Public Phonebook"
            }
            Self::ConsumerAffairs => {
                "National Consumer Affairs Center of Japan, consumer consultation office open data; adapted by Public Phonebook"
            }
            Self::LabourBureau
            | Self::LabourInspection
            | Self::LabourConsultation
            | Self::SocialWithdrawalSupport
            | Self::EmploymentOffice
            | Self::ParentEmploymentSupport
            | Self::GraduateEmploymentSupport
            | Self::YouthEmploymentSupport
            | Self::ForeignEmploymentSupport
            | Self::LocalEmploymentSupport
            | Self::AgricultureEmploymentSupport
            | Self::RelocationEmploymentSupport => {
                "Ministry of Health, Labour and Welfare, published service office directory; adapted by Public Phonebook"
            }
            Self::ChildConsultation => {
                "Children and Families Agency, national child guidance center directory; adapted by Public Phonebook"
            }
            Self::PensionOffice | Self::PensionConsultation => {
                "Japan Pension Service, published service office directory; adapted by Public Phonebook"
            }
            Self::TaxOffice => {
                "National Tax Agency, tax office directory; adapted by Public Phonebook"
            }
            Self::LegalAffairs => {
                "Ministry of Justice, legal affairs bureau directory; adapted by Public Phonebook"
            }
            Self::FireBrigadeOffice => {
                "Fire and Disaster Management Agency, volunteer fire brigade administrative contact directory; adapted by Public Phonebook"
            }
            Self::PoliceConsultation => {
                "National Police Agency, police consultation directory; adapted by Public Phonebook"
            }
            Self::Medical
            | Self::Dental
            | Self::Pharmacy
            | Self::MunicipalOffice
            | Self::PrefecturalOffice => "",
        }
    }

    pub fn additional_source(self) -> Option<(&'static str, &'static str)> {
        Some(match self {
            Self::Nursery
            | Self::Kindergarten
            | Self::CertifiedChildCenter
            | Self::SmallScaleChildcare
            | Self::WorkplaceChildcare
            | Self::UnlicensedChildcare => (
                "Children and Families Agency / WAM NET",
                "Published childcare facilities. Closed and suspended facilities, home-visit carers, and individually operated unlicensed providers are excluded.",
            ),
            Self::University | Self::JuniorCollege | Self::TechnicalCollege => (
                "Ministry of Education, Culture, Sports, Science and Technology",
                "Representative institutional contact details from national higher education lists. Personal and departmental contact fields are excluded.",
            ),
            Self::ConsumerAffairs => (
                "National Consumer Affairs Center of Japan",
                "Published consumer consultation offices. The numeric CSV omits the domestic trunk prefix; imported telephone numbers restore that prefix.",
            ),
            Self::LabourBureau | Self::LabourInspection | Self::LabourConsultation => (
                "Ministry of Health, Labour and Welfare",
                "Published labour bureaus, labour standards inspection offices, and explicitly identified labour consultation desks.",
            ),
            Self::ChildConsultation => (
                "Children and Families Agency",
                "Published child guidance centers and branch offices. These are direct office contacts, not a replacement for emergency services.",
            ),
            Self::SocialWithdrawalSupport => (
                "Ministry of Health, Labour and Welfare",
                "Published local consultation services for social withdrawal, with office addresses and direct telephone numbers.",
            ),
            Self::PensionOffice => (
                "Japan Pension Service",
                "Published pension offices and consultation centers, using each page's primary office address. Separate consultation rooms on the same page may be omitted. Check the official page for services and appointments.",
            ),
            Self::PensionConsultation => (
                "Japan Pension Service",
                "Published pension consultation centers and office staff contact numbers. These centers do not provide pension consultations by telephone. Check the official page for services and appointments.",
            ),
            Self::TaxOffice => (
                "National Tax Agency",
                "Published tax office contact numbers and office locations. Postal processing centers are excluded from the office address.",
            ),
            Self::LegalAffairs => (
                "Ministry of Justice",
                "Published legal affairs bureaus and district legal affairs bureaus.",
            ),
            Self::FireBrigadeOffice => (
                "Fire and Disaster Management Agency",
                "Administrative contacts for volunteer fire brigades, not emergency dispatch. Locations may identify only the municipality.",
            ),
            Self::PoliceConsultation => (
                "National Police Agency",
                "Non-emergency police consultation numbers. Locations identify the prefecture rather than an office street address.",
            ),
            Self::EmploymentOffice
            | Self::ParentEmploymentSupport
            | Self::GraduateEmploymentSupport
            | Self::YouthEmploymentSupport
            | Self::ForeignEmploymentSupport
            | Self::LocalEmploymentSupport
            | Self::AgricultureEmploymentSupport
            | Self::RelocationEmploymentSupport => (
                "Ministry of Health, Labour and Welfare",
                "Published public employment service offices and specialized consultation desks. Check the official page for eligible services and opening hours.",
            ),
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Phone {
    pub original: String,
    pub e164: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Contact {
    pub id: String,
    pub source_record_id: String,
    pub prefecture_code: String,
    pub prefecture: String,
    pub municipality_code: Option<String>,
    pub category: Category,
    pub name: String,
    pub address: String,
    pub phones: Vec<Phone>,
    pub official_url: Option<String>,
    pub source_id: String,
    pub source_url: String,
    pub license: String,
    pub license_url: String,
    pub data_as_of: String,
    pub retrieved_at: String,
    pub official_phone_observed: bool,
    #[serde(default)]
    pub official_phone_source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
    pub retrieved_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct SourceReport {
    pub id: String,
    pub url: String,
    pub sha256: String,
    pub data_as_of: String,
    pub retrieved_at: String,
    pub index_url: String,
    pub index_sha256: String,
    pub license_url: String,
    pub license_sha256: String,
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
    pub rows: usize,
    pub accepted: usize,
    pub missing_phone: usize,
    pub invalid: usize,
    pub duplicate: usize,
    pub issues: std::collections::BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Prefecture {
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct CoverageCell {
    pub prefecture_code: String,
    pub prefecture: String,
    pub category: Category,
    pub contacts: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Coverage {
    pub generated_at: String,
    pub total_contacts: usize,
    pub unique_phone_numbers: usize,
    pub prefectures_covered: usize,
    pub complete: bool,
    pub cells: Vec<CoverageCell>,
    pub sources: Vec<SourceReport>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Search {
    pub q: String,
    pub prefecture: String,
    pub municipality: String,
    pub category: String,
    pub page: usize,
    pub format: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchError {
    TooLong,
    Prefecture,
    Municipality,
    ConflictingRegion,
    Category,
    Format,
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::TooLong => "Search is too long",
            Self::Prefecture => "Unknown prefecture",
            Self::Municipality => "Invalid municipality code",
            Self::ConflictingRegion => "Municipality does not belong to the prefecture",
            Self::Category => "Unknown category",
            Self::Format => "Unsupported export format",
        })
    }
}

impl std::error::Error for SearchError {}

pub struct CheckedSearch<'a> {
    text: &'a str,
    region: phonebook_core::Region,
    category: Option<Category>,
    format: Option<phonebook_core::ExportFormat>,
}

impl CheckedSearch<'_> {
    pub fn text(&self) -> &str {
        self.text
    }
    pub fn region(&self) -> phonebook_core::Region {
        self.region
    }
    pub fn category(&self) -> Option<Category> {
        self.category
    }
    pub fn format(&self) -> Option<phonebook_core::ExportFormat> {
        self.format
    }
}

impl Search {
    pub fn checked(&self) -> Result<CheckedSearch<'_>, SearchError> {
        use phonebook_core::{ExportFormat, MunicipalityCode, PrefectureCode, Region};
        if self.q.len() > SEARCH_QUERY_MAX_BYTES {
            return Err(SearchError::TooLong);
        }
        let prefecture = if self.prefecture.is_empty() {
            None
        } else {
            let bytes: [u8; 2] = self
                .prefecture
                .as_bytes()
                .try_into()
                .map_err(|_| SearchError::Prefecture)?;
            Some(PrefectureCode::parse(bytes).ok_or(SearchError::Prefecture)?)
        };
        let municipality = if self.municipality.is_empty() {
            None
        } else {
            if self.municipality.len() != MUNICIPALITY_CODE_LENGTH {
                return Err(SearchError::Municipality);
            }
            Some(
                MunicipalityCode::parse(self.municipality.as_bytes())
                    .ok_or(SearchError::Municipality)?,
            )
        };
        let region = match (prefecture, municipality) {
            (Some(prefecture), Some(municipality))
                if prefecture.number() != municipality.prefecture() =>
            {
                return Err(SearchError::ConflictingRegion);
            }
            (_, Some(municipality)) => Region::Municipality(municipality),
            (Some(prefecture), None) => Region::Prefecture(prefecture),
            (None, None) => Region::All,
        };
        let category = if self.category.is_empty() {
            None
        } else {
            Some(
                Category::ALL
                    .into_iter()
                    .find(|category| category.key() == self.category)
                    .ok_or(SearchError::Category)?,
            )
        };
        let format = if self.format.is_empty() {
            None
        } else {
            Some(ExportFormat::parse(&self.format).ok_or(SearchError::Format)?)
        };
        Ok(CheckedSearch {
            text: &self.q,
            region,
            category,
            format,
        })
    }

    pub fn validate(&self) -> Result<(), SearchError> {
        self.checked().map(|_| ())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub total: usize,
    pub contacts: Vec<Contact>,
    pub page: usize,
    pub pages: usize,
}
