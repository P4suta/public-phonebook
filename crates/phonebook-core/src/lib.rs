#![no_std]

extern crate alloc;

use alloc::string::String;

pub const PAGE_SIZE: usize = 50;
pub const STREAM_CHUNK_SIZE: usize = 64 * 1024;

const HTTP_INVALID_QUERY: u16 = 400;
const HTTP_NOT_FOUND: u16 = 404;
const HTTP_METHOD_NOT_ALLOWED: u16 = 405;
const HTTP_SNAPSHOT_CHANGED: u16 = 409;
const HTTP_UNAVAILABLE: u16 = 503;
const DECIMAL_RADIX: u8 = 10;
const LAST_PREFECTURE_CODE: u8 = 47;
const MAX_TABLE_COLUMNS: usize = 64;
const MAX_TABLE_ROWSPAN: usize = 1000;
const MUNICIPALITY_CODE_BYTES: usize = 5;
const MUNICIPALITY_CHECKSUM_BYTES: usize = 6;
const MUNICIPALITY_WEIGHTS: [u16; 5] = [6, 5, 4, 3, 2];
const MUNICIPALITY_CHECKSUM_MODULUS: u16 = 11;
const MUNICIPALITY_CHECKSUM_RADIX: u16 = 10;
const DOMESTIC_PHONE_MIN_DIGITS: usize = 10;
const DOMESTIC_PHONE_MAX_DIGITS: usize = 11;
const INTERNATIONAL_PHONE_MIN_DIGITS: usize = 11;
const INTERNATIONAL_PHONE_MAX_DIGITS: usize = 12;
const VCARD_LINE_OCTETS: usize = 75;

/// A lowercase ASCII SHA-256 identity.
/// ```compile_fail
/// let unchecked = phonebook_core::SnapshotId([b'0'; 64]);
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotId([u8; 64]);

impl SnapshotId {
    pub fn parse(bytes: [u8; 64]) -> Option<Self> {
        for byte in bytes {
            if !matches!(byte, b'0'..=b'9' | b'a'..=b'f') {
                return None;
            }
        }
        Some(Self(bytes))
    }

    pub fn bytes(self) -> [u8; 64] {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
pub enum ApiProblemKind {
    InvalidQuery,
    NotFound,
    MethodNotAllowed,
    SnapshotChanged,
    Unavailable,
}

impl ApiProblemKind {
    pub const ALL: [Self; 5] = [
        Self::InvalidQuery,
        Self::NotFound,
        Self::MethodNotAllowed,
        Self::SnapshotChanged,
        Self::Unavailable,
    ];

    pub fn status(self) -> u16 {
        match self {
            Self::InvalidQuery => HTTP_INVALID_QUERY,
            Self::NotFound => HTTP_NOT_FOUND,
            Self::MethodNotAllowed => HTTP_METHOD_NOT_ALLOWED,
            Self::SnapshotChanged => HTTP_SNAPSHOT_CHANGED,
            Self::Unavailable => HTTP_UNAVAILABLE,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidQuery => "invalid_query",
            Self::NotFound => "not_found",
            Self::MethodNotAllowed => "method_not_allowed",
            Self::SnapshotChanged => "snapshot_changed",
            Self::Unavailable => "unavailable",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::InvalidQuery => "Invalid query",
            Self::NotFound => "Not found",
            Self::MethodNotAllowed => "Method not allowed",
            Self::SnapshotChanged => "Snapshot changed",
            Self::Unavailable => "Temporarily unavailable",
        }
    }

    pub fn retry_after(self) -> Option<u16> {
        match self {
            Self::Unavailable => Some(1),
            _ => None,
        }
    }
}

/// A prefecture code whose ASCII representation is always in 01..=47.
/// ```compile_fail
/// let invalid = phonebook_core::PrefectureCode(48);
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrefectureCode(u8);

impl PrefectureCode {
    pub fn parse(bytes: [u8; 2]) -> Option<Self> {
        if !bytes[0].is_ascii_digit() || !bytes[1].is_ascii_digit() {
            return None;
        }
        let number = (bytes[0] - b'0') * DECIMAL_RADIX + bytes[1] - b'0';
        if (1..=LAST_PREFECTURE_CODE).contains(&number) {
            Some(Self(number))
        } else {
            None
        }
    }
    pub fn number(self) -> u8 {
        self.0
    }
    pub fn digits(self) -> [u8; 2] {
        [b'0' + self.0 / DECIMAL_RADIX, b'0' + self.0 % DECIMAL_RADIX]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Region {
    All,
    Prefecture(PrefectureCode),
    Municipality(MunicipalityCode),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Json,
    Csv,
    Vcf,
}

impl ExportFormat {
    pub fn parse(value: &str) -> Option<Self> {
        Self::parse_bytes(value.as_bytes())
    }
    pub fn parse_bytes(value: &[u8]) -> Option<Self> {
        match value {
            b"json" => Some(Self::Json),
            b"csv" => Some(Self::Csv),
            b"vcf" => Some(Self::Vcf),
            _ => None,
        }
    }
    pub fn extension(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Csv => "csv",
            Self::Vcf => "vcf",
        }
    }
    pub fn mime(self) -> &'static str {
        match self {
            Self::Json => "application/json; charset=utf-8",
            Self::Csv => "text/csv; charset=utf-8",
            Self::Vcf => "text/vcard; charset=utf-8",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CsvTextBoundary {
    Literal,
    Quote,
}

pub fn csv_text_boundary(first: Option<char>) -> CsvTextBoundary {
    match first {
        Some('\0'..=' ' | '=' | '+' | '-' | '@' | '＝' | '＋' | '－' | '＠') => {
            CsvTextBoundary::Quote
        }
        _ => CsvTextBoundary::Literal,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageWindow {
    page: usize,
    pages: usize,
    offset: usize,
    length: usize,
}

impl PageWindow {
    pub fn new(total: usize, requested: usize) -> Self {
        let pages = total.div_ceil(PAGE_SIZE).max(1);
        let page = requested.max(1).min(pages);
        let offset = (page - 1) * PAGE_SIZE;
        Self {
            page,
            pages,
            offset,
            length: (total - offset).min(PAGE_SIZE),
        }
    }

    pub fn page(self) -> usize {
        self.page
    }
    pub fn pages(self) -> usize {
        self.pages
    }
    pub fn offset(self) -> usize {
        self.offset
    }
    pub fn length(self) -> usize {
        self.length
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkPlan {
    take: usize,
    flush: bool,
}

impl ChunkPlan {
    pub fn new(buffered: usize, incoming: usize) -> Option<Self> {
        if buffered > STREAM_CHUNK_SIZE {
            return None;
        }
        let take = incoming.min(STREAM_CHUNK_SIZE - buffered);
        Some(Self {
            take,
            flush: buffered + take == STREAM_CHUNK_SIZE,
        })
    }
    pub fn take(self) -> usize {
        self.take
    }
    pub fn flush(self) -> bool {
        self.flush
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TableSpan {
    end: usize,
    remaining_rows: usize,
}

impl TableSpan {
    pub fn parse(start: usize, width: usize, height: usize) -> Option<Self> {
        if !(1..=MAX_TABLE_COLUMNS).contains(&width) || !(1..=MAX_TABLE_ROWSPAN).contains(&height) {
            return None;
        }
        let end = start.checked_add(width)?;
        if end > MAX_TABLE_COLUMNS {
            return None;
        }
        Some(Self {
            end,
            remaining_rows: height - 1,
        })
    }

    pub fn end(self) -> usize {
        self.end
    }

    pub fn remaining_rows(self) -> usize {
        self.remaining_rows
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
pub enum ChildcareFacility {
    Nursery,
    Kindergarten,
    CertifiedChildCenter,
    SmallScale,
    Workplace,
    Unlicensed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
pub enum ChildcareKind {
    Facility(ChildcareFacility),
    Individual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
pub enum FacilityStatus {
    Operating,
    Inactive,
}

pub fn admit_childcare(kind: ChildcareKind, status: FacilityStatus) -> Option<ChildcareFacility> {
    match (kind, status) {
        (ChildcareKind::Facility(facility), FacilityStatus::Operating) => Some(facility),
        (ChildcareKind::Individual, _) | (_, FacilityStatus::Inactive) => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MunicipalityCode([u8; 5]);

impl MunicipalityCode {
    pub fn parse(input: &[u8]) -> Option<Self> {
        if !matches!(
            input.len(),
            MUNICIPALITY_CODE_BYTES | MUNICIPALITY_CHECKSUM_BYTES
        ) || !input.iter().all(u8::is_ascii_digit)
        {
            return None;
        }
        let code = Self(input.get(..MUNICIPALITY_CODE_BYTES)?.try_into().ok()?);
        if !(1..=LAST_PREFECTURE_CODE).contains(&code.prefecture()) {
            return None;
        }
        if input.len() == MUNICIPALITY_CHECKSUM_BYTES {
            let sum: u16 = code
                .0
                .iter()
                .zip(MUNICIPALITY_WEIGHTS)
                .map(|(digit, weight)| u16::from(digit - b'0') * weight)
                .sum();
            if u16::from(input[MUNICIPALITY_CODE_BYTES] - b'0')
                != (MUNICIPALITY_CHECKSUM_MODULUS - sum % MUNICIPALITY_CHECKSUM_MODULUS)
                    % MUNICIPALITY_CHECKSUM_RADIX
            {
                return None;
            }
        }
        Some(code)
    }

    pub fn digits(&self) -> &[u8; 5] {
        &self.0
    }

    pub fn prefecture(&self) -> u8 {
        (self.0[0] - b'0') * DECIMAL_RADIX + self.0[1] - b'0'
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhoneError {
    InvalidCharacter,
    InvalidLength,
    InvalidCountry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhoneCharacter {
    Digit(u8),
    InternationalPrefix,
    Separator,
    Invalid,
}

pub fn classify_phone_character(character: char) -> PhoneCharacter {
    match character {
        '0'..='9' => PhoneCharacter::Digit(character as u8),
        '０'..='９' => PhoneCharacter::Digit(b'0' + (character as u32 - '０' as u32) as u8),
        '+' | '＋' => PhoneCharacter::InternationalPrefix,
        '-' | '‐' | '‑' | '–' | '—' | '―' | '−' | '－' | 'ー' | 'ｰ' | '₋' | '⁻' | '﹣' | '('
        | ')' | '（' | '）' => PhoneCharacter::Separator,
        value if value.is_whitespace() => PhoneCharacter::Separator,
        _ => PhoneCharacter::Invalid,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Number {
    digits: [u8; 12],
    length: u8,
}

impl Number {
    pub fn digits(&self) -> &[u8] {
        &self.digits[..usize::from(self.length)]
    }
}

pub fn canonical_digits(input: &[u8], international: bool) -> Result<Number, PhoneError> {
    if !input.iter().all(u8::is_ascii_digit) {
        return Err(PhoneError::InvalidCharacter);
    }
    let mut output = Number {
        digits: [0; 12],
        length: 0,
    };
    if international {
        if !(input.len() == INTERNATIONAL_PHONE_MIN_DIGITS
            || input.len() == INTERNATIONAL_PHONE_MAX_DIGITS)
        {
            return Err(PhoneError::InvalidLength);
        }
        if !input.starts_with(b"81") || input[2] == b'0' {
            return Err(PhoneError::InvalidCountry);
        }
        output.digits[..input.len()].copy_from_slice(input);
        output.length = input.len() as u8;
    } else {
        if !(input.len() == DOMESTIC_PHONE_MIN_DIGITS || input.len() == DOMESTIC_PHONE_MAX_DIGITS) {
            return Err(PhoneError::InvalidLength);
        }
        if input[0] != b'0' || input[1] == b'0' {
            return Err(PhoneError::InvalidCountry);
        }
        output.digits[0] = b'8';
        output.digits[1] = b'1';
        output.digits[2..input.len() + 1].copy_from_slice(&input[1..]);
        output.length = (input.len() + 1) as u8;
    }
    Ok(output)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedPhone(String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EscapedVCardText(String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoldedVCardText(String);

macro_rules! text_accessors {
    ($name:ident) => {
        impl core::ops::Deref for $name {
            type Target = str;

            fn deref(&self) -> &str {
                &self.0
            }
        }

        impl core::fmt::Display for $name {
            fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

text_accessors!(NormalizedPhone);
text_accessors!(EscapedVCardText);
text_accessors!(FoldedVCardText);

pub fn normalize_phone(input: &str) -> Result<NormalizedPhone, PhoneError> {
    let mut digits = [0u8; 12];
    let mut length = 0;
    let mut international = false;
    for character in input.chars() {
        let digit = match classify_phone_character(character) {
            PhoneCharacter::Digit(value) => Some(value),
            PhoneCharacter::InternationalPrefix if length == 0 && !international => {
                international = true;
                None
            }
            PhoneCharacter::Separator => None,
            PhoneCharacter::InternationalPrefix | PhoneCharacter::Invalid => {
                return Err(PhoneError::InvalidCharacter);
            }
        };
        if let Some(value) = digit {
            if length == digits.len() {
                return Err(PhoneError::InvalidLength);
            }
            digits[length] = value;
            length += 1;
        }
    }
    let normalized = canonical_digits(&digits[..length], international)?;
    let mut result = String::from("+");
    for digit in normalized.digits() {
        result.push(char::from(*digit));
    }
    Ok(NormalizedPhone(result))
}

pub fn escaped_byte(value: u8) -> ([u8; 2], usize) {
    match value {
        b'\\' | b',' | b';' => ([b'\\', value], 2),
        b'\r' | b'\n' => (*b"\\n", 2),
        _ => ([value, 0], 1),
    }
}

pub fn escape_text(input: &str) -> EscapedVCardText {
    let mut output = String::new();
    let mut previous_cr = false;
    for character in input.chars() {
        if character == '\n' && previous_cr {
            previous_cr = false;
            continue;
        }
        previous_cr = character == '\r';
        if character.is_ascii() {
            let (bytes, length) = escaped_byte(character as u8);
            for byte in &bytes[..length] {
                output.push(char::from(*byte));
            }
        } else {
            output.push(character);
        }
    }
    EscapedVCardText(output)
}

pub fn fold_line(input: &str) -> FoldedVCardText {
    let mut output = String::new();
    let mut length = 0;
    for character in input.chars() {
        if length + character.len_utf8() > VCARD_LINE_OCTETS {
            output.push_str("\r\n ");
            length = 1;
        }
        output.push(character);
        length += character.len_utf8();
    }
    output.push_str("\r\n");
    FoldedVCardText(output)
}

#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    #[kani::unwind(66)]
    fn snapshot_identities_admit_exactly_lowercase_sha256_bytes() {
        let bytes: [u8; 64] = kani::any();
        let expected = bytes
            .iter()
            .all(|byte| (48..=57).contains(byte) || (97..=102).contains(byte));
        let identity = SnapshotId::parse(bytes);
        assert_eq!(identity.is_some(), expected);
        if let Some(identity) = identity {
            assert_eq!(identity.bytes(), bytes);
            assert_eq!(SnapshotId::parse(identity.bytes()), Some(identity));
        }
        kani::cover!(identity.is_some());
        kani::cover!(identity.is_none());
    }

    #[kani::proof]
    #[kani::unwind(64)]
    fn api_problems_preserve_status_codes_and_retry_semantics() {
        let kind: ApiProblemKind = kani::any();
        let (status, code, retry) = match kind {
            ApiProblemKind::InvalidQuery => (400, "invalid_query", None),
            ApiProblemKind::NotFound => (404, "not_found", None),
            ApiProblemKind::MethodNotAllowed => (405, "method_not_allowed", None),
            ApiProblemKind::SnapshotChanged => (409, "snapshot_changed", None),
            ApiProblemKind::Unavailable => (503, "unavailable", Some(1)),
        };
        assert_eq!(kind.status(), status);
        assert_eq!(kind.code(), code);
        assert_eq!(kind.retry_after(), retry);
        assert!(!kind.title().is_empty());
        for variant in ApiProblemKind::ALL {
            assert_eq!(kind.code() == variant.code(), kind == variant);
            kani::cover!(kind == variant);
        }
    }

    #[kani::proof]
    #[kani::unwind(3)]
    fn prefecture_codes_admit_exactly_the_47_ascii_codes() {
        let bytes: [u8; 2] = kani::any();
        let code = PrefectureCode::parse(bytes);
        let expected = bytes[0].is_ascii_digit()
            && bytes[1].is_ascii_digit()
            && bytes >= *b"01"
            && bytes <= *b"47";
        assert_eq!(code.is_some(), expected);
        if let Some(code) = code {
            assert!((1..=47).contains(&code.number()));
            assert_eq!(code.digits(), bytes);
            assert_eq!(PrefectureCode::parse(code.digits()), Some(code));
            kani::cover!(code.number() == 47);
        }
        kani::cover!(code.is_none());
    }

    #[kani::proof]
    #[kani::unwind(32)]
    fn export_formats_reject_unknown_names_and_preserve_the_selected_mime() {
        let bytes: [u8; 5] = kani::any();
        let length: usize = kani::any();
        kani::assume(length <= bytes.len());
        {
            let text = &bytes[..length];
            let format = ExportFormat::parse_bytes(text);
            assert_eq!(
                format.is_some(),
                text == b"json" || text == b"csv" || text == b"vcf"
            );
            if let Some(format) = format {
                assert_eq!(format.extension().as_bytes(), text);
                assert_eq!(ExportFormat::parse(format.extension()), Some(format));
                match format {
                    ExportFormat::Json => {
                        assert_eq!(format.mime(), "application/json; charset=utf-8")
                    }
                    ExportFormat::Csv => assert_eq!(format.mime(), "text/csv; charset=utf-8"),
                    ExportFormat::Vcf => assert_eq!(format.mime(), "text/vcard; charset=utf-8"),
                }
                kani::cover!(format == ExportFormat::Json);
                kani::cover!(format == ExportFormat::Csv);
                kani::cover!(format == ExportFormat::Vcf);
            }
            kani::cover!(format.is_none());
        }
    }

    #[kani::proof]
    #[kani::unwind(9)]
    fn csv_text_prefixes_preserve_text_boundaries_for_every_unicode_scalar() {
        let first: Option<char> = kani::any();
        let boundary = csv_text_boundary(first);
        let dangerous = first.is_some_and(|value| {
            let point = value as u32;
            point <= 32 || [43, 45, 61, 64, 0xff0b, 0xff0d, 0xff1d, 0xff20].contains(&point)
        });
        assert_eq!(
            boundary,
            if dangerous {
                CsvTextBoundary::Quote
            } else {
                CsvTextBoundary::Literal
            }
        );
        kani::cover!(dangerous);
        kani::cover!(first == Some('＝'));
        kani::cover!(first.is_none());
    }

    #[kani::proof]
    #[kani::unwind(2)]
    fn page_windows_cover_results_without_arithmetic_overflow() {
        let total: usize = kani::any();
        let requested: usize = kani::any();
        let window = PageWindow::new(total, requested);
        assert!(window.page() >= 1 && window.page() <= window.pages());
        assert!(window.offset() <= total);
        assert!(window.length() <= PAGE_SIZE);
        assert!(window.offset() + window.length() <= total);
        if window.page() == window.pages() {
            assert_eq!(window.offset() + window.length(), total);
        } else {
            assert_eq!(window.length(), PAGE_SIZE);
            let next = PageWindow::new(total, window.page() + 1);
            assert_eq!(next.offset(), window.offset() + window.length());
        }
        kani::cover!(total == usize::MAX && requested == usize::MAX);
        kani::cover!(total == 0);
    }

    #[kani::proof]
    #[kani::unwind(2)]
    fn streaming_chunk_plans_preserve_capacity_and_progress() {
        let buffered: usize = kani::any();
        let incoming: usize = kani::any();
        let plan = ChunkPlan::new(buffered, incoming);
        assert_eq!(plan.is_some(), buffered <= STREAM_CHUNK_SIZE);
        if let Some(plan) = plan {
            assert!(plan.take() <= incoming);
            assert!(buffered + plan.take() <= STREAM_CHUNK_SIZE);
            assert_eq!(plan.flush(), buffered + plan.take() == STREAM_CHUNK_SIZE);
            if incoming > 0 {
                assert!(plan.take() > 0 || plan.flush());
            }
            kani::cover!(incoming == usize::MAX && plan.flush());
        }
        kani::cover!(plan.is_none());
    }

    #[kani::proof]
    #[kani::unwind(2)]
    fn table_spans_refuse_overflow_and_preserve_bounds() {
        let start: usize = kani::any();
        let width: usize = kani::any();
        let height: usize = kani::any();
        let valid = (1..=64).contains(&width)
            && (1..=1000).contains(&height)
            && start <= 64
            && width <= 64 - start;
        let span = TableSpan::parse(start, width, height);
        assert_eq!(span.is_some(), valid);
        if let Some(span) = span {
            assert!(start < span.end() && span.end() <= 64);
            assert_eq!(span.end() - start, width);
            assert!(span.remaining_rows() < 1000);
            assert_eq!(span.remaining_rows() + 1, height);
            kani::cover!(width == 64 && height == 1000);
        }
        kani::cover!(start == usize::MAX && span.is_none());
    }

    #[kani::proof]
    #[kani::unwind(2)]
    fn childcare_admission_excludes_inactive_and_individual_care() {
        let kind: ChildcareKind = kani::any();
        let status: FacilityStatus = kani::any();
        let admitted = admit_childcare(kind, status);
        match (kind, status) {
            (ChildcareKind::Facility(facility), FacilityStatus::Operating) => {
                assert_eq!(admitted, Some(facility));
                kani::cover!(facility == ChildcareFacility::Unlicensed);
            }
            (ChildcareKind::Individual, _) | (_, FacilityStatus::Inactive) => {
                assert!(admitted.is_none());
                kani::cover!(true);
            }
        }
    }

    #[kani::proof]
    #[kani::unwind(16)]
    fn phone_characters_preserve_the_declared_alphabet() {
        let character: char = kani::any();
        let classified = classify_phone_character(character);
        let digit = matches!(character, '0'..='9' | '０'..='９');
        let prefix = matches!(character, '+' | '＋');
        let separator = character.is_whitespace()
            || matches!(
                character,
                '-' | '‐'
                    | '‑'
                    | '–'
                    | '—'
                    | '―'
                    | '−'
                    | '－'
                    | 'ー'
                    | 'ｰ'
                    | '₋'
                    | '⁻'
                    | '﹣'
                    | '('
                    | ')'
                    | '（'
                    | '）'
            );
        assert_eq!(matches!(classified, PhoneCharacter::Digit(_)), digit);
        assert_eq!(classified == PhoneCharacter::InternationalPrefix, prefix);
        assert_eq!(classified == PhoneCharacter::Separator, separator);
        assert_eq!(
            classified == PhoneCharacter::Invalid,
            !digit && !prefix && !separator
        );
        if let PhoneCharacter::Digit(value) = classified {
            assert!(value.is_ascii_digit());
            assert!(
                character as u32 == u32::from(value)
                    || character as u32 == '０' as u32 + u32::from(value - b'0')
            );
        }
        kani::cover!(classified == PhoneCharacter::Separator);
        kani::cover!(matches!(classified, PhoneCharacter::Digit(_)));
    }

    #[kani::proof]
    #[kani::unwind(9)]
    fn municipality_codes_preserve_validated_digits() {
        let input: [u8; 7] = kani::any();
        let length: usize = kani::any();
        kani::assume(length <= input.len());
        if let Some(code) = MunicipalityCode::parse(&input[..length]) {
            assert!(length == 5 || length == 6);
            assert!(code.digits().iter().all(u8::is_ascii_digit));
            assert!((1..=47).contains(&code.prefecture()));
            assert_eq!(code.digits().as_slice(), &input[..5]);
            assert_eq!(MunicipalityCode::parse(code.digits()), Some(code));
            if length == 6 {
                let d = code.digits();
                let sum = u16::from(d[0] - b'0') * 6
                    + u16::from(d[1] - b'0') * 5
                    + u16::from(d[2] - b'0') * 4
                    + u16::from(d[3] - b'0') * 3
                    + u16::from(d[4] - b'0') * 2;
                assert_eq!(u16::from(input[5] - b'0'), (11 - sum % 11) % 10);
            }
            kani::cover!(length == 5);
            kani::cover!(length == 6);
        }
    }

    #[kani::proof]
    #[kani::unwind(14)]
    fn canonical_numbers_are_bounded_and_reparse() {
        let input: [u8; 12] = kani::any();
        let length: usize = kani::any();
        kani::assume(length <= input.len());
        let international: bool = kani::any();
        if let Ok(number) = canonical_digits(&input[..length], international) {
            assert!(number.length == 11 || number.length == 12);
            assert!(number.digits().starts_with(b"81"));
            assert!(number.digits().iter().all(u8::is_ascii_digit));
            assert_eq!(canonical_digits(number.digits(), true), Ok(number));
            kani::cover!(true);
        }
    }

    #[kani::proof]
    #[kani::unwind(2)]
    fn special_bytes_cannot_add_properties() {
        let value: u8 = kani::any();
        let (bytes, length) = escaped_byte(value);
        assert!(length == 1 || length == 2);
        assert!(bytes[0] != b'\r' && bytes[0] != b'\n');
        if matches!(value, b'\\' | b',' | b';' | b'\n' | b'\r') {
            assert_eq!(length, 2);
            assert_eq!(bytes[0], b'\\');
            assert!(bytes[1] != b'\r' && bytes[1] != b'\n');
        } else {
            assert_eq!(bytes[0], value);
        }
        kani::cover!(true);
    }

    #[cfg(feature = "proof-negative-control")]
    #[kani::proof]
    #[kani::unwind(2)]
    fn reject_a_false_escape_claim() {
        kani::assert(
            escaped_byte(b'\n').0[0] == b'\n',
            "negative control: raw newline retained",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_windows_clamp_inputs_and_preserve_every_boundary() {
        for (total, requested, expected) in [
            (0, 0, (1, 1, 0, 0)),
            (1, 0, (1, 1, 0, 1)),
            (50, 2, (1, 1, 0, 50)),
            (51, 2, (2, 2, 50, 1)),
            (100, usize::MAX, (2, 2, 50, 50)),
        ] {
            let window = PageWindow::new(total, requested);
            assert_eq!(
                (
                    window.page(),
                    window.pages(),
                    window.offset(),
                    window.length()
                ),
                expected
            );
        }
        let last = PageWindow::new(usize::MAX, usize::MAX);
        assert_eq!(last.offset() + last.length(), usize::MAX);
    }

    #[test]
    fn streaming_chunks_refuse_invalid_buffers_and_never_exceed_capacity() {
        assert!(ChunkPlan::new(STREAM_CHUNK_SIZE + 1, 1).is_none());
        for (buffered, incoming, expected) in [
            (0, usize::MAX, (STREAM_CHUNK_SIZE, true)),
            (0, 0, (0, false)),
            (STREAM_CHUNK_SIZE - 1, 2, (1, true)),
            (STREAM_CHUNK_SIZE, 1, (0, true)),
            (2, 3, (3, false)),
        ] {
            let plan = ChunkPlan::new(buffered, incoming).unwrap();
            assert_eq!((plan.take(), plan.flush()), expected);
        }
    }

    #[test]
    fn table_spans_are_bounded_before_expansion() {
        assert_eq!(TableSpan::parse(0, 64, 1000).unwrap().end(), 64);
        assert_eq!(TableSpan::parse(63, 1, 1).unwrap().remaining_rows(), 0);
        for (start, width, height) in [
            (0, 0, 1),
            (0, 1, 0),
            (64, 1, 1),
            (63, 2, 1),
            (0, 65, 1),
            (0, 1, 1001),
            (usize::MAX, 2, 1),
        ] {
            assert!(TableSpan::parse(start, width, height).is_none());
        }
    }

    #[test]
    fn childcare_admission_requires_an_operating_facility() {
        for facility in [
            ChildcareFacility::Nursery,
            ChildcareFacility::Kindergarten,
            ChildcareFacility::CertifiedChildCenter,
            ChildcareFacility::SmallScale,
            ChildcareFacility::Workplace,
            ChildcareFacility::Unlicensed,
        ] {
            let kind = ChildcareKind::Facility(facility);
            assert_eq!(
                admit_childcare(kind, FacilityStatus::Operating),
                Some(facility)
            );
            assert_eq!(admit_childcare(kind, FacilityStatus::Inactive), None);
        }
        for status in [FacilityStatus::Operating, FacilityStatus::Inactive] {
            assert_eq!(admit_childcare(ChildcareKind::Individual, status), None);
        }
    }

    #[test]
    fn municipality_codes_preserve_leading_zeroes_and_check_digits() {
        for (plain, checked) in [
            ("01101", "011011"),
            ("13101", "131016"),
            ("47201", "472018"),
        ] {
            let code = MunicipalityCode::parse(plain.as_bytes()).unwrap();
            assert_eq!(code.digits().as_slice(), plain.as_bytes());
            assert_eq!(MunicipalityCode::parse(checked.as_bytes()), Some(code));
            assert_eq!(code.prefecture(), plain[..2].parse::<u8>().unwrap());
        }
    }

    #[test]
    fn municipality_codes_refuse_bad_prefixes_lengths_characters_and_checksums() {
        for input in [
            "", "0110", "0110111", "00101", "48101", "ab101", "01101x", "011010", "131015",
        ] {
            assert!(
                MunicipalityCode::parse(input.as_bytes()).is_none(),
                "{input}"
            );
        }
    }

    #[test]
    fn equivalent_japanese_numbers_have_one_identity() {
        for value in [
            "03-5321-1111",
            "０３－５３２１－１１１１",
            "+81 3 5321 1111",
            "(03) 5321 1111",
        ] {
            assert_eq!(normalize_phone(value).as_deref(), Ok("+81353211111"));
        }
        assert_eq!(
            normalize_phone("090-1234-5678").as_deref(),
            Ok("+819012345678")
        );
    }

    #[test]
    fn published_compatibility_hyphens_and_unicode_spaces_preserve_digits() {
        for (published, expected) in [
            ("080ｰ9443-9583", "+818094439583"),
            ("0144₋84₋6925", "+81144846925"),
            ("０２７⁻２８９－３８１５", "+81272893815"),
            ("03﹣1234﹣5678", "+81312345678"),
            ("03\u{00a0}1234\u{2009}5678", "+81312345678"),
        ] {
            assert_eq!(
                normalize_phone(published).as_deref(),
                Ok(expected),
                "{published}"
            );
        }
    }

    #[test]
    fn missing_or_foreign_digits_are_not_invented() {
        for value in [
            "",
            "3-5321-1111",
            "123",
            "+1 212 555 0123",
            "03-5321-1111 ext 2",
            "03-5321-1111\nFAX 03-5321-1112",
        ] {
            assert!(normalize_phone(value).is_err(), "{value}");
        }
    }

    #[test]
    fn text_cannot_create_a_vcard_property() {
        assert_eq!(
            &*escape_text("a,b;c\\d\r\nTEL:evil"),
            "a\\,b\\;c\\\\d\\nTEL:evil"
        );
    }

    #[test]
    fn utf8_folding_preserves_text_and_octet_limits() {
        let text = "住所;".repeat(50);
        let folded = fold_line(&text);
        assert!(folded.split("\r\n").all(|line| line.len() <= 75));
        assert_eq!(folded.trim_end_matches("\r\n").replace("\r\n ", ""), text);
    }
}
