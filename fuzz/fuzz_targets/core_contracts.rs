#![no_main]

use libfuzzer_sys::fuzz_target;
use phonebook_core::{
    ExportFormat, MunicipalityCode, PrefectureCode, SnapshotId, TableSpan, canonical_digits,
    escape_text, fold_line, normalize_phone,
};

fn check(input: &[u8]) {
    if let Ok(bytes) = <[u8; 2]>::try_from(input)
        && let Some(code) = PrefectureCode::parse(bytes)
    {
        assert!((1..=47).contains(&code.number()));
        assert_eq!(code.digits(), bytes);
        assert_eq!(PrefectureCode::parse(code.digits()), Some(code));
    }
    if let Ok(bytes) = <[u8; 64]>::try_from(input)
        && let Some(identity) = SnapshotId::parse(bytes)
    {
        assert!(
            bytes
                .iter()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        );
        assert_eq!(identity.bytes(), bytes);
        assert_eq!(SnapshotId::parse(identity.bytes()), Some(identity));
    }
    if let Some(code) = MunicipalityCode::parse(input) {
        assert!((1..=47).contains(&code.prefecture()));
        assert!(input.starts_with(code.digits()));
        assert_eq!(MunicipalityCode::parse(code.digits()), Some(code));
    }
    if let Some(format) = ExportFormat::parse_bytes(input) {
        assert_eq!(format.extension().as_bytes(), input);
        assert_eq!(ExportFormat::parse(format.extension()), Some(format));
    }
    for international in [false, true] {
        if let Ok(number) = canonical_digits(input, international) {
            assert!(number.digits().iter().all(u8::is_ascii_digit));
            assert!(matches!(number.digits().len(), 11 | 12));
            assert_eq!(canonical_digits(number.digits(), true), Ok(number));
        }
    }
    let start = input
        .get(..size_of::<usize>())
        .and_then(|bytes| bytes.try_into().ok())
        .map(usize::from_le_bytes)
        .unwrap_or(0);
    let width = usize::from(input.first().copied().unwrap_or(0));
    let height = usize::from(input.get(1).copied().unwrap_or(0));
    for start in [start, usize::MAX] {
        if let Some(span) = TableSpan::parse(start, width, height) {
            assert!((1..=64).contains(&width));
            assert!((1..=1000).contains(&height));
            assert!(span.end() <= 64);
            assert_eq!(span.end().checked_sub(width), Some(start));
            assert_eq!(span.remaining_rows().checked_add(1), Some(height));
        }
    }
    if let Ok(text) = std::str::from_utf8(input) {
        if let Ok(number) = normalize_phone(text) {
            assert!(number.starts_with("+81"));
            assert!(matches!(number.len(), 12 | 13));
            assert_eq!(normalize_phone(&number), Ok(number));
        }
        let escaped = escape_text(text);
        assert!(!escaped.contains(['\r', '\n']));
        let folded = fold_line(&escaped);
        assert!(folded.split("\r\n").all(|line| line.len() <= 75));
        let unfolded = folded
            .strip_suffix("\r\n")
            .expect("a folded value has its line terminator")
            .replace("\r\n ", "");
        assert_eq!(unfolded.as_str(), &*escaped);
    }
}

fuzz_target!(|data: &[u8]| {
    check(data);
    if let Some(trimmed) = data.strip_suffix(b"\n") {
        check(trimmed);
    }
});
