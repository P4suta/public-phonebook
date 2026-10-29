use public_phonebook::model::*;

pub fn fixture() -> (Vec<Contact>, Vec<Prefecture>, Vec<SourceReport>) {
    let mut contacts = Vec::new();
    let prefectures: Vec<_> = (1..=47)
        .map(|n| Prefecture {
            code: format!("{n:02}"),
            name: format!("Test prefecture {n}"),
        })
        .collect();
    for p in &prefectures {
        for category in Category::ALL {
            contacts.push(Contact {
                id: format!("{}:{}", p.code, category.key()),
                source_record_id: p.code.clone(),
                prefecture_code: p.code.clone(),
                prefecture: p.name.clone(),
                municipality_code: Some(format!("{}001", p.code)),
                category,
                name: format!("Test facility <script> {}", category.key()),
                address: "Test address; floor 1".into(),
                phones: vec![Phone {
                    original: "03-0000-0000".into(),
                    e164: "+81300000000".into(),
                }],
                official_url: None,
                source_id: "test".into(),
                source_url: "https://example.com/source".into(),
                license: "CC0-1.0".into(),
                license_url: "https://creativecommons.org/publicdomain/zero/1.0/".into(),
                data_as_of: "2026-10-01".into(),
                retrieved_at: "2026-10-29T00:00:00Z".into(),
                official_phone_observed: false,
                official_phone_source: None,
            });
        }
    }
    let reports = vec![SourceReport {
        id: "test".into(),
        rows: contacts.len(),
        accepted: contacts.len(),
        ..Default::default()
    }];
    (contacts, prefectures, reports)
}
