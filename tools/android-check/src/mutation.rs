use crate::{completed, sdk, source_refinement_with_model, write_json};
use anyhow::{Context, Result, ensure};
use roxmltree::Document;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const CATALOG: &str = "verification/android/mutations.json";
const POLICY_CASE_SEED: u32 = 0x5048_4f4e;
const NORMALIZATION_CASE_SEED: u32 = 0x5345_4152;
const SQL_CASE_SEED: u32 = 0x0053_514c;
const POLICY_CLASSES: [&str; 6] = [
    "CallerPolicy",
    "TransferPolicy",
    "PublicationPolicy",
    "PagePolicy",
    "JsonPolicy",
    "WordPolicy",
];

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Module {
    Core,
    Data,
    App,
}

impl Module {
    fn name(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Data => "data",
            Self::App => "app",
        }
    }
    fn package(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Data => "data",
            Self::App => "publicphonebook",
        }
    }
    fn task(self) -> &'static str {
        match self {
            Self::Core => ":core:test",
            Self::Data => ":data:testDebugUnitTest",
            Self::App => ":app:testVerificationDebugUnitTest",
        }
    }
    fn results(self) -> &'static str {
        match self {
            Self::Core => "test",
            Self::Data => "testDebugUnitTest",
            Self::App => "testVerificationDebugUnitTest",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Mutation {
    id: String,
    module: Module,
    file: String,
    test: String,
    original: String,
    replacement: String,
}

impl Mutation {
    fn source(&self) -> String {
        format!(
            "apps/android/{}/src/main/kotlin/page/dial/{}/{}",
            self.module.name(),
            self.module.package(),
            self.file
        )
    }
    fn suite(&self) -> String {
        format!("page.dial.{}.{}", self.module.package(), self.test)
    }
    fn report(&self, root: &Path) -> PathBuf {
        root.join(format!(
            "apps/android/{}/build/test-results/{}/TEST-{}.xml",
            self.module.name(),
            self.module.results(),
            self.suite()
        ))
    }
    fn apply(&self, original: &str) -> Result<String> {
        ensure!(
            !self.original.is_empty()
                && self.original != self.replacement
                && original.matches(&self.original).count() == 1,
            "Mutation {} has a missing or ambiguous source expression",
            self.id
        );
        Ok(original.replacen(&self.original, &self.replacement, 1))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    format: u32,
    mutations: Vec<Mutation>,
}

fn catalog(root: &Path) -> Result<Catalog> {
    let catalog: Catalog = serde_json::from_slice(&fs::read(root.join(CATALOG))?)?;
    ensure!(
        catalog.format == 1 && !catalog.mutations.is_empty(),
        "Missing mutation inventory"
    );
    let mut ids = BTreeSet::new();
    for mutation in &catalog.mutations {
        ensure!(
            mutation
                .id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                && !mutation.id.is_empty()
                && ids.insert(&mutation.id),
            "Invalid or duplicate mutation identity"
        );
        ensure!(
            mutation.file.ends_with(".kt")
                && mutation
                    .file
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
                && !mutation.file.contains(".."),
            "Invalid mutation file"
        );
        ensure!(
            mutation.test.ends_with("Test")
                && mutation
                    .test
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric()),
            "Invalid test suite"
        );
        mutation.apply(&fs::read_to_string(root.join(mutation.source()))?)?;
    }
    for module in [Module::Core, Module::Data, Module::App] {
        ensure!(
            catalog
                .mutations
                .iter()
                .any(|mutation| mutation.module.name() == module.name()),
            "Missing {} mutations",
            module.name()
        );
    }
    Ok(catalog)
}

pub fn validate(root: &Path) -> Result<()> {
    catalog(root).map(|_| ())
}

#[derive(Debug, PartialEq)]
struct Tests {
    names: BTreeSet<String>,
    failures: usize,
    aborted: bool,
}

fn infrastructure_failure(failure: roxmltree::Node<'_, '_>) -> bool {
    let kinds = [
        "java.lang.OutOfMemoryError",
        "java.util.concurrent.TimeoutException",
        "org.junit.runners.model.TestTimedOutException",
        "kotlinx.coroutines.test.UncompletedCoroutinesError",
        "org.junit.runners.model.InitializationError",
        "org.junit.internal.runners.InitializationError",
        "java.lang.NoClassDefFoundError",
        "java.lang.ClassNotFoundException",
        "java.lang.UnsatisfiedLinkError",
        "java.lang.LinkageError",
        "java.nio.file.AccessDeniedException",
    ];
    if kinds.contains(&failure.attribute("type").unwrap_or_default()) {
        return true;
    }
    let messages = [
        "Inconclusive:",
        "No space left on device",
        "Read-only file system",
        "Too many open files",
        "Could not resolve",
    ];
    let notice = |text: &str| messages.iter().any(|message| text.contains(message));
    if notice(failure.attribute("message").unwrap_or_default()) {
        return true;
    }
    failure
        .text()
        .unwrap_or_default()
        .lines()
        .enumerate()
        .any(|(index, line)| {
            let line = line.trim_start();
            let exception = if let Some(cause) = line.strip_prefix("Caused by: ") {
                cause
            } else if let Some(cause) = line.strip_prefix("Suppressed: ") {
                cause
            } else if index == 0 {
                line
            } else {
                return false;
            };
            kinds.contains(&exception.split(':').next().unwrap_or_default()) || notice(exception)
        })
}

fn tests(xml: &str, suite: &str) -> Result<Tests> {
    let document = Document::parse(xml)?;
    let root = document.root_element();
    ensure!(
        root.has_tag_name("testsuite") && root.attribute("name") == Some(suite),
        "Unexpected JUnit suite"
    );
    let mut names = BTreeSet::new();
    let mut failures = 0;
    let mut aborted = false;
    for case in root.children().filter(|node| node.has_tag_name("testcase")) {
        let name = case.attribute("name").context("Missing test name")?;
        ensure!(
            case.attribute("classname") == Some(suite) && names.insert(name.to_owned()),
            "Unexpected or duplicate test case"
        );
        for child in case.children().filter(|node| node.is_element()) {
            if child.has_tag_name("skipped") {
                aborted = true;
            }
            if child.has_tag_name("failure") || child.has_tag_name("error") {
                failures += 1;
                aborted |= infrastructure_failure(child);
            }
        }
    }
    ensure!(!names.is_empty(), "Empty JUnit suite");
    ensure!(
        root.attribute("tests")
            .context("Missing JUnit count")?
            .parse::<usize>()?
            == names.len(),
        "Incomplete JUnit inventory"
    );
    Ok(Tests {
        names,
        failures,
        aborted,
    })
}

fn behavioral_kill(compiled: bool, completed: bool, failed: bool, aborted: bool) -> bool {
    compiled && completed && failed && !aborted
}

fn complete_campaign(expected: usize, executed: usize, all_killed: bool) -> bool {
    expected > 0 && expected == executed && all_killed
}

fn command(root: &Path, args: &[&str]) -> Result<Command> {
    let mut command = crate::gradle_command(root);
    command
        .env("ANDROID_HOME", sdk()?)
        .env("CARGO_NET_OFFLINE", "true")
        .args(args)
        .args(["--no-build-cache", "--console=plain", "--max-workers=2"]);
    Ok(command)
}

fn execute(root: &Path, args: &[&str], log: &Path) -> Result<Output> {
    let output = command(root, args)?.output()?;
    let mut bytes = output.stdout.clone();
    bytes.extend_from_slice(&output.stderr);
    fs::write(log, bytes)?;
    Ok(output)
}

fn copy_inputs(root: &Path, checkout: &Path) -> Result<()> {
    fs::create_dir(checkout)?;
    let mut listing = Command::new("git");
    listing
        .current_dir(root)
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
        ])
        .args(crate::BUILD_INPUT_PATHS);
    for file in String::from_utf8(completed(listing)?.stdout)?
        .split('\0')
        .filter(|file| !file.is_empty())
    {
        let destination = checkout.join(file);
        fs::create_dir_all(destination.parent().context("Missing checkout parent")?)?;
        ensure!(
            fs::symlink_metadata(root.join(file))?.is_file(),
            "Mutation inputs must be regular files: {file}"
        );
        fs::copy(root.join(file), destination)?;
    }
    let declaration: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("apps/android/bundled-dataset.json"))?)?;
    let sha = declaration["sha256"]
        .as_str()
        .context("Missing bundled hash")?;
    ensure!(crate::hash_shape(sha), "Invalid bundle identity");
    let cache = checkout.join("target/android/cache");
    fs::create_dir_all(&cache)?;
    fs::copy(
        root.join(format!("target/android/cache/{sha}.br")),
        cache.join(format!("{sha}.br")),
    )
    .context("Run android-check to cache the pinned national archive")?;
    Ok(())
}

fn policy_report(xml: &str) -> Result<usize> {
    let document = Document::parse(xml)?;
    ensure!(
        document.root_element().has_tag_name("mutations"),
        "Invalid PIT report"
    );
    let mut classes = BTreeSet::new();
    let mut count = 0;
    for mutation in document
        .root_element()
        .children()
        .filter(|node| node.has_tag_name("mutation"))
    {
        count += 1;
        let class = mutation
            .children()
            .find(|node| node.has_tag_name("mutatedClass"))
            .and_then(|node| node.text())
            .context("Missing PIT class")?;
        classes.insert(class.to_owned());
        ensure!(
            mutation.attribute("status") == Some("KILLED")
                && mutation.attribute("detected") == Some("true")
                && mutation
                    .attribute("numberOfTestsRun")
                    .context("Missing PIT test count")?
                    .parse::<usize>()?
                    > 0,
            "Unresolved PIT mutation in {class}: {:?}",
            mutation.attribute("status")
        );
        ensure!(
            mutation
                .children()
                .any(|node| node.has_tag_name("killingTest")
                    && node.text().is_some_and(|value| !value.is_empty())),
            "Missing killing test"
        );
    }
    ensure!(
        classes
            == POLICY_CLASSES
                .iter()
                .map(|name| format!("page.dial.core.{name}"))
                .collect()
            && count > 0,
        "Incomplete PIT policy inventory"
    );
    Ok(count)
}

pub fn run(root: &Path, plan: bool, selected: &[String]) -> Result<()> {
    let catalog = catalog(root)?;
    for id in selected {
        ensure!(
            catalog.mutations.iter().any(|mutation| mutation.id == *id),
            "Unknown mutation: {id}"
        );
    }
    let selection: Vec<_> = catalog
        .mutations
        .iter()
        .filter(|mutation| selected.is_empty() || selected.contains(&mutation.id))
        .collect();
    if plan {
        println!(
            "PIT 1.30.1: DEFAULTS operators, six policy classes, one worker; {} source contract mutations selected",
            selection.len()
        );
        for mutation in selection {
            println!(
                "{}: {} -> {}",
                mutation.id,
                mutation.source(),
                mutation.suite()
            );
        }
        return Ok(());
    }
    let output = root.join("target/android/mutation");
    fs::create_dir_all(&output)?;
    let lock = fs::File::create(output.join("campaign.lock"))?;
    lock.try_lock()
        .context("Another Android mutation campaign is running")?;
    let sources = source_refinement_with_model(root)?;
    let receipt = output.join("receipt.json");
    if receipt.exists() {
        fs::remove_file(&receipt)?;
    }
    let mut nonce = [0_u8; 8];
    getrandom::fill(&mut nonce)
        .map_err(|error| anyhow::anyhow!("Cannot allocate mutation run: {error}"))?;
    let directory = output.join(format!("run-{}", crate::digest(&nonce)));
    fs::create_dir(&directory)?;
    let checkout = directory.join("checkout");
    copy_inputs(root, &checkout)?;
    println!("Building an unmutated baseline in {}", directory.display());
    let baseline = execute(
        &checkout,
        &[
            ":core:test",
            ":data:testDebugUnitTest",
            ":app:testVerificationDebugUnitTest",
        ],
        &directory.join("baseline.txt"),
    )?;
    ensure!(
        baseline.status.success(),
        "Mutation baseline failed; inspect {}/baseline.txt",
        directory.display()
    );
    let mut baselines = BTreeMap::new();
    for mutation in &selection {
        let result = tests(
            &fs::read_to_string(mutation.report(&checkout))?,
            &mutation.suite(),
        )?;
        ensure!(
            result.failures == 0 && !result.aborted,
            "Invalid baseline suite"
        );
        baselines.insert(mutation.suite(), result.names);
        fs::copy(
            mutation.report(&checkout),
            directory.join(format!("baseline-{}.xml", mutation.suite())),
        )?;
    }
    write_json(&directory.join("baseline-tests.json"), &baselines)?;
    fs::copy(root.join(CATALOG), directory.join("mutations.json"))?;
    let mut results = Vec::new();
    for mutation in selection {
        let file = checkout.join(mutation.source());
        let original = fs::read_to_string(&file)?;
        let modified = mutation.apply(&original)?;
        fs::write(&file, modified.as_bytes())?;
        let xml_path = mutation.report(&checkout);
        if xml_path.exists() {
            fs::remove_file(&xml_path)?;
        }
        let log = directory.join(format!("{}.txt", mutation.id));
        let result = execute(
            &checkout,
            &[mutation.module.task(), "--tests", &mutation.suite()],
            &log,
        );
        fs::write(file, original.as_bytes())?;
        let result = result?;
        let text = fs::read_to_string(&log)?;
        let compiled = !text.contains("Compilation error")
            && !text.contains("Could not resolve")
            && !text.contains("compiler errors found during analysis");
        let parsed = fs::read_to_string(&xml_path)
            .ok()
            .and_then(|xml| tests(&xml, &mutation.suite()).ok());
        let complete = parsed
            .as_ref()
            .is_some_and(|test| baselines.get(&mutation.suite()) == Some(&test.names));
        let failed = parsed.as_ref().is_some_and(|test| test.failures > 0);
        let aborted = parsed.as_ref().is_none_or(|test| test.aborted)
            || result
                .status
                .code()
                .is_none_or(|code| code != 0 && code != 1)
            || result.status.success() == failed;
        let killed = behavioral_kill(compiled, complete, failed, aborted);
        let verdict = if killed {
            "killed"
        } else if !compiled {
            "build-rejected"
        } else if !complete || aborted {
            "inconclusive"
        } else {
            "survived"
        };
        println!("{}: {verdict}", mutation.id);
        if xml_path.exists() {
            fs::copy(xml_path, directory.join(format!("{}.xml", mutation.id)))?;
        }
        results.push(json!({"id":mutation.id,"source":mutation.source(),"originalSha256":crate::digest(original.as_bytes()),"mutatedSha256":crate::digest(modified.as_bytes()),"verdict":verdict}));
        write_json(&directory.join("results.json"), &results)?;
        ensure!(
            verdict != "inconclusive",
            "Inconclusive mutation execution; inspect {}",
            directory.display()
        );
    }
    let passed = complete_campaign(
        catalog.mutations.len(),
        results.len(),
        results.iter().all(|result| result["verdict"] == "killed"),
    );
    ensure!(
        sources == source_refinement_with_model(root)?,
        "Sources changed during mutation testing"
    );
    if !selected.is_empty() {
        ensure!(
            results.iter().all(|result| result["verdict"] == "killed"),
            "Unresolved selected mutations; inspect {}",
            directory.display()
        );
        println!("Selected mutations passed; no full-campaign receipt was issued");
        fs::remove_dir_all(checkout)?;
        return Ok(());
    }
    ensure!(
        passed,
        "Unresolved mutations; inspect {}",
        directory.display()
    );
    let policy_xml = root.join("apps/android/core/build/reports/pitest/mutations.xml");
    if policy_xml.exists() {
        fs::remove_file(&policy_xml)?;
    }
    let policy = execute(
        root,
        &[":core:pitest", "--rerun-tasks"],
        &directory.join("pitest.txt"),
    )?;
    ensure!(
        policy.status.success(),
        "PIT failed; inspect {}/pitest.txt",
        directory.display()
    );
    let policy_count = policy_report(&fs::read_to_string(&policy_xml)?)?;
    fs::copy(policy_xml, directory.join("pitest.xml"))?;
    ensure!(
        sources == source_refinement_with_model(root)?,
        "Sources changed during PIT"
    );
    write_json(
        &receipt,
        &json!({"sources":sources,"sourceMutations":results,"sourceMutationCount":results.len(),"baselineTests":baselines.values().map(BTreeSet::len).sum::<usize>(),"policyMutations":policy_count,"pitest":"1.30.1","operators":"DEFAULTS","workers":1,"seeds":{"policies":POLICY_CASE_SEED,"normalization":NORMALIZATION_CASE_SEED,"sql":SQL_CASE_SEED},"result":"passed","evidence":directory.strip_prefix(root)?.to_string_lossy()}),
    )?;
    fs::remove_dir_all(checkout)?;
    println!(
        "Android mutation campaign passed: {policy_count} PIT mutations and {} source contract mutations killed",
        results.len()
    );
    Ok(())
}

pub fn require_current(root: &Path) -> Result<()> {
    let value: serde_json::Value = serde_json::from_slice(
        &fs::read(root.join("target/android/mutation/receipt.json"))
            .context("Run android-mutate for this source")?,
    )?;
    let expected = catalog(root)?;
    let results = value["sourceMutations"]
        .as_array()
        .context("Missing source mutation results")?;
    ensure!(
        value["sources"] == serde_json::to_value(source_refinement_with_model(root)?)?
            && value["result"] == "passed"
            && value["pitest"] == "1.30.1"
            && value["policyMutations"]
                .as_u64()
                .is_some_and(|count| count > 0),
        "Stale or incomplete Android mutation evidence"
    );
    ensure!(
        value["sourceMutationCount"].as_u64() == Some(u64::try_from(results.len())?)
            && value["baselineTests"]
                .as_u64()
                .is_some_and(|count| count > 0)
            && complete_campaign(
                expected.mutations.len(),
                results.len(),
                results.iter().all(|result| result["verdict"] == "killed")
            )
            && results
                .iter()
                .map(|value| value["id"].as_str().unwrap_or_default())
                .collect::<BTreeSet<_>>()
                == expected
                    .mutations
                    .iter()
                    .map(|mutation| mutation.id.as_str())
                    .collect(),
        "Incomplete source mutation inventory"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_mutation_builds_keep_the_real_version_tool_and_its_dependencies() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut git = Command::new("git");
        git.current_dir(root.path()).args(["init", "--quiet"]);
        completed(git)?;
        let hash = "a".repeat(64);
        for (path, content) in [
            (
                "apps/android/bundled-dataset.json".to_owned(),
                json!({"sha256":hash}).to_string(),
            ),
            (
                format!("target/android/cache/{hash}.br"),
                "fixture archive".to_owned(),
            ),
            ("apps/android/version.txt".to_owned(), "1.0.0".to_owned()),
            (
                "tools/delivery/Cargo.toml".to_owned(),
                "[workspace]\nmembers = [\"core\"]".to_owned(),
            ),
            (
                "tools/delivery/core/src/identities.rs".to_owned(),
                "pub struct Version;".to_owned(),
            ),
            ("LICENSE-APACHE".to_owned(), "fixture license".to_owned()),
            ("mise.lock".to_owned(), "fixture tool lock".to_owned()),
            (
                "apps/ios/Sources/PhonebookKit/PlaceReadings.json".to_owned(),
                "fixture readings".to_owned(),
            ),
            (
                "apps/ios/Tests/PhonebookKitTests/PlaceReadingContract.json".to_owned(),
                "fixture reading contract".to_owned(),
            ),
        ] {
            let path = root.path().join(path);
            fs::create_dir_all(path.parent().context("Missing fixture parent")?)?;
            fs::write(path, content)?;
        }
        let parent = tempfile::tempdir()?;
        let checkout = parent.path().join("checkout");
        copy_inputs(root.path(), &checkout)?;
        for path in [
            "apps/android/version.txt",
            "tools/delivery/Cargo.toml",
            "tools/delivery/core/src/identities.rs",
            "LICENSE-APACHE",
            "mise.lock",
            "apps/ios/Sources/PhonebookKit/PlaceReadings.json",
            "apps/ios/Tests/PhonebookKitTests/PlaceReadingContract.json",
        ] {
            assert_eq!(
                fs::read(root.path().join(path))?,
                fs::read(checkout.join(path))?
            );
        }
        Ok(())
    }

    #[test]
    fn incomplete_or_aborted_executions_never_kill_a_mutant() {
        for mask in 0..16 {
            let facts = [mask & 1 != 0, mask & 2 != 0, mask & 4 != 0, mask & 8 != 0];
            assert_eq!(
                behavioral_kill(facts[0], facts[1], facts[2], facts[3]),
                mask == 7
            );
        }
        for expected in 0..5 {
            for executed in 0..5 {
                for all_killed in [false, true] {
                    assert_eq!(
                        complete_campaign(expected, executed, all_killed),
                        expected != 0 && executed == expected && all_killed
                    );
                }
            }
        }
    }

    #[test]
    fn junit_reports_distinguish_assertions_from_infrastructure_and_skips() -> Result<()> {
        let report = |body: &str| {
            format!(
                "<testsuite name='Suite' tests='1'><testcase name='contract' classname='Suite'>{body}</testcase></testsuite>"
            )
        };
        let assertion = tests(
            &report("<failure type='java.lang.AssertionError'>expected a rejection</failure>"),
            "Suite",
        )?;
        assert!(assertion.failures == 1 && !assertion.aborted);
        for body in [
            "<skipped/>",
            "<failure type='java.lang.OutOfMemoryError'/>",
            "<failure type='java.lang.NoClassDefFoundError'/>",
            "<failure type='java.util.concurrent.TimeoutException'/>",
            "<failure type='java.io.IOException' message='No space left on device'/>",
            "<failure type='java.lang.AssertionError'>java.lang.AssertionError\nCaused by: java.util.concurrent.TimeoutException: guard expired</failure>",
        ] {
            assert!(tests(&report(body), "Suite")?.aborted);
        }
        assert!(tests("<testsuite name='Suite' tests='0'/>", "Suite").is_err());
        assert!(tests(&report(""), "Other").is_err());
        assert!(tests("<testsuite name='Suite' tests='2'><testcase name='contract' classname='Suite'/></testsuite>", "Suite").is_err());
        Ok(())
    }

    #[test]
    fn pit_reports_require_executed_kills_for_every_policy_class() -> Result<()> {
        let report = |status: &str| {
            let mutations = POLICY_CLASSES.iter().map(|class| format!("<mutation detected='true' status='{status}' numberOfTestsRun='1'><mutatedClass>page.dial.core.{class}</mutatedClass><killingTest>Suite.contract</killingTest></mutation>")).collect::<String>();
            format!("<mutations>{mutations}</mutations>")
        };
        assert_eq!(policy_report(&report("KILLED"))?, POLICY_CLASSES.len());
        for status in [
            "NO_COVERAGE",
            "SURVIVED",
            "TIMED_OUT",
            "RUN_ERROR",
            "MEMORY_ERROR",
            "NON_VIABLE",
            "NOT_STARTED",
        ] {
            assert!(policy_report(&report(status)).is_err());
        }
        assert!(policy_report("<mutations/>").is_err());
        assert!(
            policy_report(
                &report("KILLED").replace("numberOfTestsRun='1'", "numberOfTestsRun='0'")
            )
            .is_err()
        );
        assert!(
            policy_report(&report("KILLED").replace(
                "<killingTest>Suite.contract</killingTest>",
                "<killingTest/>"
            ))
            .is_err()
        );
        Ok(())
    }

    #[test]
    fn assertion_stack_frames_are_not_timeout_evidence() -> Result<()> {
        let xml = "<testsuite name='Suite' tests='1'><testcase name='lookupTimeout' classname='Suite'><failure type='java.lang.AssertionError' message='expected false'>java.lang.AssertionError\n at Suite.lookupTimeout(Suite.kt:1)</failure></testcase></testsuite>";
        let result = tests(xml, "Suite")?;
        assert_eq!(result.failures, 1);
        assert!(!result.aborted);
        Ok(())
    }
}
