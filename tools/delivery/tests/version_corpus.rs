#[path = "../fuzz/contract.rs"]
mod contract;
use anyhow::Result;
use std::{fs, path::Path};

const MINIMUM_SEEDS: usize = 10;

#[test]
fn replay_version_parser_corpus_and_canonical_round_trips() -> Result<()> {
    let corpus = Path::new(env!("CARGO_MANIFEST_DIR")).join("fuzz/corpus/version_identities");
    let mut count = 0;
    for entry in fs::read_dir(corpus)? {
        let entry = entry?;
        assert!(entry.file_type()?.is_file());
        contract::check(&fs::read(entry.path())?);
        count += 1;
    }
    assert!(count >= MINIMUM_SEEDS);
    Ok(())
}
