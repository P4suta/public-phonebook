use phonebook_core::{escape_text, fold_line, normalize_phone};
use proptest::{prelude::*, test_runner::RngSeed};
use public_phonebook::store;

mod support;

fn unescape(input: &str) -> String {
    let mut output = String::new();
    let mut chars = input.chars();
    while let Some(value) = chars.next() {
        if value == '\\' {
            let escaped = chars.next().expect("Escaped character");
            output.push(if escaped == 'n' { '\n' } else { escaped });
        } else {
            output.push(value);
        }
    }
    output
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 1024, rng_seed: RngSeed::Fixed(0x5048_4f4e_4542_4f4f), max_shrink_iters: 4096, ..ProptestConfig::default() })]

    #[test]
    fn japanese_digit_width_and_separators_preserve_the_number(
        tail in "[1-9][0-9]{8,9}",
        separator in prop::sample::select(vec!["-", " ", "－", "ー", "ｰ", "₋", "⁻", "﹣", "\u{00a0}", "\u{2009}", "\t", ""]),
        wide in any::<bool>(),
    ) {
        let domestic = format!("0{tail}");
        let decorated = domestic.chars().map(|c| {
            if wide { char::from_u32('０' as u32 + c as u32 - '0' as u32).unwrap().to_string() }
            else { c.to_string() }
        }).collect::<Vec<_>>().join(separator);
        let expected = format!("+81{tail}");
        prop_assert_eq!(normalize_phone(&decorated).map(String::from), Ok(expected.clone()));
        prop_assert_eq!(normalize_phone(&expected).map(String::from), Ok(expected));
    }

    #[test]
    fn unicode_text_roundtrips_through_escape_and_utf8_folding(chars in prop::collection::vec(any::<char>(), 0..128)) {
        let text: String = chars.into_iter().collect();
        let escaped = escape_text(&text);
        prop_assert!(!escaped.contains(['\r', '\n']));
        let folded = fold_line(&escaped);
        prop_assert!(folded.split("\r\n").all(|line| line.len() <= 75));
        let unfolded = folded.strip_suffix("\r\n").unwrap().replace("\r\n ", "");
        prop_assert_eq!(unfolded.as_str(), &*escaped);
        prop_assert_eq!(unescape(&unfolded), text.replace("\r\n", "\n").replace('\r', "\n"));
    }

    #[test]
    fn csv_roundtrips_arbitrary_unicode_names_and_addresses(
        name in prop::collection::vec(any::<char>(), 0..64),
        address in prop::collection::vec(any::<char>(), 0..64),
    ) {
        let mut contact = support::fixture().0.remove(0);
        contact.name = name.into_iter().collect();
        contact.address = address.into_iter().collect();
        let (bytes, _) = store::export(&[contact.clone()], "csv").unwrap();
        let mut reader = csv::Reader::from_reader(bytes.as_slice());
        let record = reader.records().next().unwrap().unwrap();
        for (value, original) in [(&record[5], &contact.name), (&record[6], &contact.address)] {
            let guarded = format!("'{original}");
            prop_assert!(value == original || value == guarded);
            prop_assert!(!value.starts_with(['=', '+', '-', '@', '\t', '\r', '\n', ' ', '＝', '＋', '－', '＠']));
        }
        prop_assert_eq!(reader.records().count(), 0);
    }

    #[test]
    fn source_text_cannot_add_vcard_properties(text in prop::collection::vec(any::<char>(), 0..128)) {
        let mut contact = support::fixture().0.remove(0);
        contact.name = format!("{}\r\nEND:VCARD\r\nBEGIN:VCARD\r\nTEL:injected", text.into_iter().collect::<String>());
        contact.address = contact.name.clone();
        let card = store::vcard(&contact);
        let unfolded = card.replace("\r\n ", "");
        prop_assert_eq!(unfolded.lines().filter(|line| *line == "BEGIN:VCARD").count(), 1);
        prop_assert_eq!(unfolded.lines().filter(|line| *line == "END:VCARD").count(), 1);
        prop_assert_eq!(unfolded.lines().filter(|line| line.starts_with("TEL:")).count(), 0);
        prop_assert!(card.split("\r\n").all(|line| line.len() <= 75));
    }
}
