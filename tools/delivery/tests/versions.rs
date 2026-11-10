mod support;
use anyhow::{Result, bail};
use delivery::{
    repository::revision,
    runtime::Github,
    versions::{self, App},
};
use serde_json::json;
use std::collections::VecDeque;
use support::Repository;

#[derive(Default)]
struct Provider {
    responses: VecDeque<String>,
    reads: Vec<Vec<String>>,
    writes: Vec<Vec<String>>,
}
impl Github for Provider {
    fn read(&mut self, arguments: &[String]) -> Result<String> {
        self.reads.push(arguments.to_vec());
        self.responses
            .pop_front()
            .ok_or_else(|| anyhow::anyhow!("Unexpected read"))
    }
    fn dispatch(&mut self, arguments: &[String]) -> Result<()> {
        if arguments.first().is_none_or(|argument| argument != "pr") {
            bail!("Version preparation must not publish");
        }
        self.writes.push(arguments.to_vec());
        Ok(())
    }
}

#[test]
fn root_generators_bump_apps_and_web_presentation_does_not() -> Result<()> {
    let repo = Repository::new()?;
    let baseline = revision(&repo.root, "HEAD")?;
    for (path, message) in [
        (
            "apps/web/src/ui/search.css",
            "fix(web): adjust search spacing",
        ),
        ("apps/ios/App/Search.swift", "fix(ios): optimize search"),
        (
            "packages/directory/src/normalization.ts",
            "fix(search): normalize shared readings",
        ),
        (
            "apps/android/app/src/Search.kt",
            "feat(android): expose categories",
        ),
    ] {
        repo.write(path, "fixture\n")?;
        repo.commit_as(message)?;
    }
    let ios = versions::request(&repo.root, App::Ios)?;
    let android = versions::request(&repo.root, App::Android)?;
    assert_eq!(ios.baseline, baseline);
    assert_eq!(
        ios.commits
            .iter()
            .map(|commit| commit.include)
            .collect::<Vec<_>>(),
        [false, true, true, false]
    );
    assert_eq!(
        android
            .commits
            .iter()
            .map(|commit| commit.include)
            .collect::<Vec<_>>(),
        [false, false, true, true]
    );
    repo.write("apps/ios/version.txt", "1.1.0\n")?;
    repo.write("releases/ios/manifest.json", "{\".\":\"1.1.0\"}\n")?;
    repo.commit_as("chore(ios): prepare version 1.1.0")?;
    let next = versions::request(&repo.root, App::Ios)?;
    assert_eq!(next.version, "1.1.0");
    assert_eq!(next.baseline, next.source);
    assert!(next.commits.is_empty());
    repo.write(
        "packages/directory/src/normalization.ts",
        "another fixture\n",
    )?;
    assert!(versions::request(&repo.root, App::Ios).is_err());
    repo.commit_as("fix(search): preserve canonical numbers")?;
    assert_eq!(versions::request(&repo.root, App::Ios)?.commits.len(), 1);
    Ok(())
}

#[test]
fn merged_preparations_are_acknowledged_without_a_release_or_tag() -> Result<()> {
    let repo = Repository::new()?;
    repo.write("apps/ios/version.txt", "1.1.0\n")?;
    repo.write("releases/ios/manifest.json", "{\".\":\"1.1.0\"}\n")?;
    repo.commit_as("chore(ios): prepare version 1.1.0")?;
    let source = revision(&repo.root, "HEAD")?;
    let mut provider = Provider {
        responses: VecDeque::from([
            source.to_string(),
            json!([
                {"number":1,"headRefName":"release-please--branches--main--components--ios","mergedSha":source,"labels":["version:ios:pending"]},
                {"number":2,"headRefName":"release-please--branches--main--components--android","mergedSha":source,"labels":["version:android:pending"]}
            ]).to_string(),
        ]),
        ..Provider::default()
    };
    versions::prepare(&repo.root, &mut provider, App::Ios)?;
    assert!(provider.reads.iter().any(|arguments| {
        arguments
            .windows(2)
            .any(|pair| pair == ["--label", "version:ios:pending"])
    }));
    assert_eq!(provider.writes.len(), 1);
    assert_eq!(
        provider.writes[0],
        [
            "pr",
            "edit",
            "1",
            "--repo",
            "P4suta/public-phonebook",
            "--remove-label",
            "version:ios:pending",
            "--add-label",
            "version:ios:merged"
        ]
    );
    assert!(
        repo.root
            .join("target/delivery/version-request.json")
            .is_file()
    );
    assert!(repo.git(&["tag", "--list"])?.is_empty());
    Ok(())
}

#[test]
fn misleading_preparation_labels_cannot_mutate_github() -> Result<()> {
    let repo = Repository::new()?;
    let source = revision(&repo.root, "HEAD")?;
    for (branch, merge) in [
        ("unrelated-branch", source.to_string()),
        (
            "release-please--branches--main--components--ios",
            "a".repeat(40),
        ),
    ] {
        let mut provider = Provider {
            responses: VecDeque::from([
                source.to_string(),
                json!([{"number":1,"headRefName":branch,"mergedSha":merge,"labels":["version:ios:pending"]}]).to_string(),
            ]),
            ..Provider::default()
        };
        assert!(versions::prepare(&repo.root, &mut provider, App::Ios).is_err());
        assert!(provider.writes.is_empty());
    }
    repo.write("releases/ios/manifest.json", "{\".\":\"9.0.0\"}\n")?;
    repo.commit()?;
    assert!(versions::request(&repo.root, App::Ios).is_err());
    Ok(())
}
