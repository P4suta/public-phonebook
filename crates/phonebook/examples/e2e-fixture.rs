#[path = "../tests/support/mod.rs"]
mod support;

use anyhow::{Context, Result};
use public_phonebook::{model::Phone, store, web};

const PROVIDER_DOWNLOAD_URL: &str = "https://example.com/providers.xlsx";
const PROVIDER_INDEX_URL: &str = "https://example.com/provider-list";
const OFFICIAL_TEST_URL: &str = "https://example.com/official";

#[tokio::main]
async fn main() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let (mut contacts, prefectures, mut reports) = support::fixture();
    reports[0].url = PROVIDER_DOWNLOAD_URL.into();
    reports[0].index_url = PROVIDER_INDEX_URL.into();
    contacts
        .iter_mut()
        .find(|contact| contact.id == "13:medical")
        .context("Missing medical test contact")?
        .official_url = Some(OFFICIAL_TEST_URL.into());
    let special = contacts
        .iter_mut()
        .find(|c| c.id == "13:dental")
        .context("Missing test contact")?;
    special.name = "試験歯科 <script> & Test, clinic".into();
    special.address = "Test, address;\nSuite 2\\東".into();
    special.official_url = Some("javascript:alert('test')".into());
    special.phones.push(Phone {
        original: "090-1234-5678".into(),
        e164: "+819012345678".into(),
    });
    let coverage = store::coverage(
        &contacts,
        &prefectures,
        reports,
        "2026-10-29T00:00:00Z".into(),
    );
    store::build_database(
        &directory.path().join("phonebook.sqlite"),
        &contacts,
        &coverage,
    )?;
    web::serve(directory.path().to_owned(), 3100).await
}
