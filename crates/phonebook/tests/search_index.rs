use public_phonebook::{model::Search, store};

mod support;

#[test]
fn indexed_name_search_preserves_literal_matches_filters_order_and_pagination() {
    let (contacts, prefectures, sources) = support::fixture();
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("phonebook.sqlite");
    let coverage = store::coverage(&contacts, &prefectures, sources, "fixed".into());
    store::build_database(&database, &contacts, &coverage).unwrap();
    let connection = store::open(&database).unwrap();
    let columns = connection
        .prepare("SELECT name FROM pragma_index_info('contact_name') ORDER BY seqno")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(columns, ["name", "id"]);
    for q in [
        "",
        "facility",
        "<script>",
        "DENTAL",
        "pharmacy",
        "not-found",
        "' OR",
        "%",
        "ＦＡＣＩＬＩＴＹ",
    ] {
        for region in ["", "13", "47", "13001", "47001"] {
            for category in ["", "dental", "pharmacy"] {
                let municipal = region.len() == 5;
                let query = Search {
                    q: q.into(),
                    prefecture: if municipal {
                        String::new()
                    } else {
                        region.into()
                    },
                    municipality: if municipal {
                        region.into()
                    } else {
                        String::new()
                    },
                    category: category.into(),
                    ..Default::default()
                };
                let needle = store::normalized(q);
                let mut expected = contacts
                    .iter()
                    .filter(|contact| {
                        (region.is_empty()
                            || if municipal {
                                contact.municipality_code.as_deref() == Some(region)
                            } else {
                                contact.prefecture_code == region
                            })
                            && (category.is_empty() || contact.category.key() == category)
                            && store::normalized(&contact.name).contains(&needle)
                    })
                    .map(|contact| contact.id.clone())
                    .collect::<Vec<_>>();
                expected.sort();
                for paginate in [false, true] {
                    let result = store::search(&database, &query, paginate).unwrap();
                    assert_eq!(result.total, expected.len());
                    let wanted = if paginate {
                        &expected[..expected.len().min(phonebook_core::PAGE_SIZE)]
                    } else {
                        &expected
                    };
                    let actual = result
                        .contacts
                        .into_iter()
                        .map(|contact| contact.id)
                        .collect::<Vec<_>>();
                    assert_eq!(actual, wanted, "{q} {region} {category} {paginate}");
                }
            }
        }
    }
}
