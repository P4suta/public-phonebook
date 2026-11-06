mod support;
use anyhow::Result;
use delivery::{
    model::{Check, PlanRecord, Target},
    repository::{plan, revision, validate_plan},
};
use support::Repository;

#[test]
fn committed_shared_changes_require_both_clients_without_publishing_both() -> Result<()> {
    let repo = Repository::new()?;
    let base = revision(&repo.root, "HEAD")?;
    repo.write("src/server/datasets.ts", "export const format = 1;\n")?;
    repo.commit()?;
    let record = plan(
        &repo.root,
        revision(&repo.root, "HEAD")?,
        Some(base),
        Some(vec![Target::Worker]),
        None,
    )?;
    assert_eq!(record.plan.targets, [Target::Worker]);
    for check in [
        Check::Ios,
        Check::Android,
        Check::Worker,
        Check::Compatibility,
    ] {
        assert!(record.plan.checks.contains(&check));
    }
    validate_plan(&repo.root, &record)?;
    let mut tampered = record.plan.clone();
    tampered.checks.retain(|check| *check != Check::Android);
    assert!(validate_plan(&repo.root, &PlanRecord::seal(tampered)?).is_err());
    let mut tampered = record;
    tampered.plan.versions.ios = "2.0.0".to_owned();
    assert!(validate_plan(&repo.root, &tampered).is_err());
    Ok(())
}

#[test]
fn native_versions_and_changes_are_read_from_the_chosen_commit() -> Result<()> {
    let repo = Repository::new()?;
    let base = revision(&repo.root, "HEAD")?;
    repo.write("ios/version.txt", "1.1.0\n")?;
    repo.commit()?;
    let source = revision(&repo.root, "HEAD")?;
    repo.write("ios/version.txt", "9.9.9\n")?;
    let record = plan(&repo.root, source.clone(), Some(base.clone()), None, None)?;
    assert_eq!(record.plan.versions.ios, "1.1.0");
    assert_eq!(record.plan.versions.android, "1.0.0");
    assert_eq!(record.plan.targets, [Target::Ios]);
    assert!(plan(&repo.root, base, Some(source), None, None).is_err());
    repo.write("ios/version.txt", "01.0.0\n")?;
    repo.commit()?;
    assert!(
        plan(
            &repo.root,
            revision(&repo.root, "HEAD")?,
            None,
            Some(vec![Target::Ios]),
            None
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn missing_baselines_unknown_paths_and_renames_never_silently_skip_checks() -> Result<()> {
    let repo = Repository::new()?;
    let base = revision(&repo.root, "HEAD")?;
    let no_base = plan(&repo.root, base.clone(), None, None, None)?;
    assert!(no_base.plan.selection_required);
    assert_eq!(no_base.plan.checks.len(), Check::ALL.len());
    repo.write("new-runtime/adapter.rs", "fn runtime() {}\n")?;
    repo.commit()?;
    let unknown = plan(
        &repo.root,
        revision(&repo.root, "HEAD")?,
        Some(base),
        None,
        None,
    )?;
    assert!(unknown.plan.selection_required);
    assert_eq!(unknown.plan.checks, no_base.plan.checks);
    let base = revision(&repo.root, "HEAD")?;
    repo.git(&["mv", "new-runtime/adapter.rs", "android/adapter.rs"])?;
    repo.commit()?;
    let renamed = plan(
        &repo.root,
        revision(&repo.root, "HEAD")?,
        Some(base),
        Some(vec![Target::Android]),
        None,
    )?;
    assert_eq!(renamed.plan.changed.len(), 2);
    assert_eq!(renamed.plan.checks.len(), Check::ALL.len());
    Ok(())
}
