use crate::locations::{FIXTURE_PORT, LOOPBACK_HOST};
use anyhow::{Context, Result, bail, ensure};
use clap::Subcommand;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};
mod app_info;
mod build_number;
mod distribution;
mod failure;
mod lease;
mod mutation;
mod proof;
mod receipts;
mod screenshots;
mod signing;
mod store_build;
mod testflight;

use build_number::BuildNumber;
use signing::Signing;

struct GateLease {
    _file: fs::File,
}

impl GateLease {
    fn acquire(path: &Path) -> Result<Self> {
        fs::create_dir_all(path.parent().context("Gate lease directory missing")?)?;
        let file = fs::File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        file.try_lock()
            .context("Another iOS verification command holds this gate's resources")?;
        Ok(Self { _file: file })
    }
}

impl Drop for GateLease {
    fn drop(&mut self) {
        if let Err(error) = self._file.unlock() {
            eprintln!("iOS check: gate lease unlock failed; closing its file releases it: {error}");
        }
    }
}

const RUNTIME: &str = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
const DEVICE_TYPE: &str = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
const DEVICE_NAME: &str = "Public Phonebook Checks";
const LIVE_UI_TEST: &str = "testLivePublicDirectorySearchAndSource";
/// A hang guard that exceeds the longest sum of one scenario's own waits.
/// The live onboarding alone waits up to 300 s, and the transfer resume scenario's waits add up to about 135 s.
const SCENARIO_ALLOWANCE_SECONDS: u32 = 600;
/// The longest single wait in a scenario, the live onboarding's `timeout: 300` in `DirectoryUITests.swift`.
const LONGEST_SCENARIO_WAIT_SECONDS: u32 = 300;
const _: () = assert!(SCENARIO_ALLOWANCE_SECONDS > LONGEST_SCENARIO_WAIT_SECONDS);
const PASSED: &str = "passed";
const FAILED: &str = "failed";
const INCONCLUSIVE: &str = "inconclusive";

/// Holds when XCTest ended a test on its execution time allowance rather than on an assertion.
fn exceeded_allowance(text: &str) -> bool {
    text.to_ascii_lowercase()
        .contains("exceeded execution time allowance")
}

fn scenario_outcome(passed: bool, hung: bool) -> &'static str {
    if passed {
        PASSED
    } else if hung {
        INCONCLUSIVE
    } else {
        FAILED
    }
}
/// Measures the process footprint, so it runs in its own invocation where no concurrent test allocates.
const ISOLATED_FOOTPRINT_TEST: &str = "readerFootprintStaysFlatWhenRunAlone";
const ISOLATED_FOOTPRINT_VARIABLE: &str = "PHONEBOOK_ISOLATED_FOOTPRINT";
const SANITIZED_CONTRACTS: [&str; 3] = [
    "byteParserMatchesTheStringParserOnEveryMutatedLine",
    "readerBufferStaysBoundedOverMoreEntriesThanTheNationalDirectory",
    "cancellationBeforeAndDuringRealRequestsAlwaysCompletes",
];
const UI_TESTS: [&str; 17] = [
    "testOnboardingSavesTheDirectoryBeforeSearch",
    "testSearchGroupsResultsAndShowsMore",
    "testTelephoneSearchFindsEveryRecordForTheNumber",
    "testEmptyResultsAndLargeText",
    "testContactDetailShowsRegionSourceAndExternalLinkConfirmation",
    "testPhoneNumberIsTextOverTheCallButton",
    "testCallerPromptAppearsOnlyWhileCallerNamesAreOff",
    "testVerificationNumberAppearsInSearchAndClears",
    "testPortraitLandscapeRoundTrip",
    "testBackgroundForegroundPreservesSearchAndDetail",
    "testFirstDownloadWaitsForTheStartButton",
    "testFirstDownloadShowsItsStepsWhileReceiving",
    "testFirstDownloadResumesAfterAWeakSignalAndAStop",
    "testDirectoryFailureRecoversWithoutATap",
    "testFailedAutomaticUpdateKeepsTheSavedDirectory",
    "testLandscapeLargeTextSettings",
    "testAboutStaysInTheAppAndLicenseIsReadable",
];
const REQUIRED_TESTS: [&str; 59] = [
    "currentProviderArchiveImportsTheNationalDirectory",
    "providerArchiveSavesTheExpectedGenerationContent",
    "byteParserMatchesTheStringParserOnEveryMutatedLine",
    "everyNameListUpToThreeMatchesTheSetBasedLabelRule",
    "savedProgressFollowsTheSavedRows",
    "cancellingWhileSavingKeepsTheSavedGeneration",
    "anInterruptedImportKeepsTheActiveGenerationUntilTheNextSaveRemovesIt",
    "importTracesTheDurationOfEachPhase",
    "archiveRecordsCarryEveryField",
    "malformedArchivesAreRejected",
    "archiveRowsMustBeSortedAndCounted",
    "datasetDownloadsRequireTheirSnapshotTypeLengthAndDigest",
    "phoneQueriesMatchTheWebNormalizer",
    "nameQueriesUseTheWebNormalizationAndRanks",
    "localSearchRanksLikeTheWebsite",
    "phoneMatchesGroupEveryRecordForTheNumber",
    "directoryModelShowsPreviewsAndMore",
    "savedContactsKeepTheirRegionPhonesAndProvenance",
    "callerEntriesAreSortedAndSharedNumbersHaveOneLabel",
    "failedOrCancelledImportsKeepTheActiveGeneration",
    "earlierStorageFormatsAreTreatedAsUnsaved",
    "everyPublicationInputPreservesThePreviousSnapshot",
    "everyProductionPublicationTransitionRefinesTheProofContract",
    "receiveBudgetGuardsSignedBoundsWithoutOverflow",
    "cancellationBeforeAndDuringRealRequestsAlwaysCompletes",
    "neitherJSONNorExportRequestsFollowRedirects",
    "actualTransportRejectsDecompressedBodiesAboveTheLimit",
    "failedActivationKeepsBothReadableGenerationsAndAllowsRecovery",
    "anUnknownActivationOutcomeRetainsItsDatabaseUntilRecovery",
    "callerNotificationFailuresRetryUntilTheirGenerationIsRecorded",
    "synchronizationPublishesOnlyCompleteValidatedArchives",
    "synchronizationPreservesPrimaryAndCleanupFailures",
    "everyASCIIPrefecturePairMatchesTheIndependentGrammarAndCodableBoundary",
    "everyPrefectureOrderingPairMatchesItsNumericMeaning",
    "snapshotByteSubstitutionsAndLengthsMatchTheIndependentGrammar",
    "canonicalPhoneMutationsMatchTheIndependentGrammarAndNumericIdentity",
    "everyConsumerAvailabilityFailureReceiptAndForceCombinationPreservesIndependentProgress",
    "automaticRefreshMatchesIndependentGregorianMonthEndsAcrossFourCenturies",
    "deltaAdmissionRefinesTheProviderOrderingAndCopyGuard",
    "storedRowsReencodeTheirArchiveLines",
    "deltasRebuildTheTargetArchiveByteForByte",
    "everyDeltaFaultIsRejectedBeforeStaging",
    "synchronizationAppliesDeltasAndFallsBackToTheCompleteArchive",
    "currentProviderDeltaRebuildsTheUpdatedArchive",
    "everyWaitTraceRefinesTheProofContract",
    "waitPromisesHoldOnSeededRandomTraces",
    "waitArithmeticStaysWithinInt64AtTheClampedExtremes",
    "anInterruptedDownloadResumesWithARangeRequest",
    "aServerThatIgnoresTheRangeRestartsTheFile",
    "aChangedSnapshotOrDigestDiscardsTheKeptBytes",
    "aWrongContentRangeOrAnUnsatisfiableRangeKeepsNoBadBytes",
    "synchronizationResumesTheBytesOfAFailedAttempt",
    "mergedCallersMatchTheLeanModelOnSeededInputs",
    "aSharedNumberTakesTheExtraLabelOnce",
    "theExtraEntryJoinsBeforeAfterOrWithoutTheNationalNumbers",
    "callerEntriesAcceptSearchSpellingsAndRefuseOthers",
    "everyBackgroundTimeTransitionEndsTheTaskOnce",
    "expiryCancelsATransferAndReleasesItsLock",
    "expiryCancelsAnImportAndReleasesTheDatabase",
];
const SCOPE: [&str; 19] = [
    "ios",
    "verification/ios",
    "src/core",
    "src/server",
    "tools",
    "mise.toml",
    "justfile",
    ".github/workflows/checks.yml",
    ".github/workflows/ios.yml",
    ".github/actions/toolchain",
    ".github/actionlint.yaml",
    ".gitignore",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "biome.json",
    "design",
    "public",
    "src/ui/icons.tsx",
];
const SHA1_HEX_LENGTH: usize = 40;
const SHA256_HEX_LENGTH: usize = 64;
const SIMULATOR_IDENTIFIER_LENGTH: usize = 36;
const FIXTURE_READINESS: Duration = Duration::from_secs(30);
const FIXTURE_READINESS_POLL: Duration = Duration::from_millis(100);
const FIXTURE_TERMINATION_GRACE: Duration = Duration::from_secs(5);
const FIXTURE_TERMINATION_POLL: Duration = Duration::from_millis(50);
const FINITE_FEED_INPUTS: usize = 8;
const FINITE_PUBLICATION_INPUTS: usize = 16;
const PUBLICATION_TRANSITIONS: usize = 25;
const RECEIVE_BUDGET_BOUNDARY_CASES: usize = 13_829;
const DELTA_ADMISSION_CASES: usize = 13_896;

fn source_hashes(root: &Path) -> Result<BTreeMap<String, String>> {
    let output = super::checked(
        Command::new("git")
            .current_dir(root)
            .args([
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
                "--",
            ])
            .args(SCOPE),
    )?;
    let mut paths = String::from_utf8(output.stdout)?
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if root.join("ios/Signing.local.xcconfig").is_file() {
        paths.push("ios/Signing.local.xcconfig".to_owned());
    }
    let mut hashes = BTreeMap::new();
    for path in paths {
        let bytes =
            fs::read(root.join(&path)).with_context(|| format!("Read iOS check input {path}"))?;
        hashes.insert(path, crate::sha256_hex(bytes));
    }
    ensure!(
        hashes.keys().any(|path| path.starts_with("ios/Sources/")),
        "The iOS gate has no production Swift inputs"
    );
    Ok(hashes)
}

fn require_current_sources(root: &Path, expected: &BTreeMap<String, String>) -> Result<()> {
    let current = source_hashes(root)?;
    let changed = expected
        .keys()
        .chain(current.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|path| expected.get(*path) != current.get(*path))
        .cloned()
        .collect::<Vec<_>>();
    ensure!(
        changed.is_empty(),
        "iOS check inputs changed during verification; no receipt was written: {}",
        changed.join(", ")
    );
    Ok(())
}

fn source_records(sources: &BTreeMap<String, String>) -> Vec<Value> {
    sources
        .iter()
        .map(|(path, digest)| json!({"path":path,"sha256":digest}))
        .collect()
}

#[derive(Subcommand)]
pub enum Action {
    Audit,
    Icons {
        #[arg(long, conflicts_with = "check")]
        import: Option<PathBuf>,
        #[arg(long)]
        check: bool,
    },
    Generate,
    Archive {
        #[arg(long)]
        require_receipts: bool,
        #[arg(long)]
        build_number: Option<u32>,
        #[arg(long, value_enum, default_value_t = Signing::Local)]
        signing: Signing,
    },
    BuildNumber {
        #[arg(long)]
        run_number: u32,
        #[arg(long)]
        run_attempt: u32,
        #[arg(long)]
        output: Option<PathBuf>,
    },
    Testflight,
    /// Builds Release with the verification tools condition and requires the store-build step to reject it.
    StoreBuildControl,
    Screenshots {
        #[arg(long)]
        origin: String,
    },
    Check,
    UnitTest,
    Prove,
    Sanitize,
    Mutate,
    UiTest {
        #[arg(long = "test")]
        tests: Vec<String>,
        #[arg(long, conflicts_with = "tests")]
        live: bool,
    },
    Affected {
        #[arg(long)]
        base: String,
        #[arg(long)]
        output: Option<PathBuf>,
    },
}

const SECRET_ENVIRONMENT: [&str; 7] = [
    signing::CERTIFICATE,
    signing::CERTIFICATE_PASSWORD,
    signing::APP_PROFILE,
    signing::EXTENSION_PROFILE,
    testflight::KEY_ID,
    testflight::ISSUER_ID,
    testflight::PRIVATE_KEY,
];

fn without_secrets(command: &mut Command) -> &mut Command {
    for secret in SECRET_ENVIRONMENT {
        command.env_remove(secret);
    }
    command
}

fn logged(root: &Path, name: &str, command: &mut Command) -> Result<Output> {
    logged_work(root, name, command, &[])
}

/// Runs a logged step and adds `work` to its deterministic counters.
fn logged_work(
    root: &Path,
    name: &str,
    command: &mut Command,
    work: &[(&str, u64)],
) -> Result<Output> {
    println!("iOS check: {name}");
    let output = super::steps::measured_output(name, without_secrets(command), work)?;
    let directory = root.join("target/ios");
    fs::create_dir_all(&directory)?;
    let log = directory.join(format!("{name}.log"));
    let mut contents = output.stdout.clone();
    contents.extend_from_slice(&output.stderr);
    fs::write(&log, contents)?;
    ensure!(
        output.status.success(),
        "{name} failed with {}; inspect {}",
        output.status,
        log.display()
    );
    Ok(output)
}

fn generate(root: &Path) -> Result<()> {
    let assets = root.join("ios/GeneratedAssets.xcassets");
    fs::create_dir_all(&assets)?;
    fs::write(
        assets.join("Contents.json"),
        serde_json::to_vec_pretty(&json!({"info":{"version":1,"author":"xcode"}}))?,
    )?;
    super::icons::generate(root, false)?;
    logged(
        root,
        "generate",
        Command::new("xcodegen")
            .current_dir(root.join("ios"))
            .arg("generate"),
    )?;
    app_info::derive(root)?;
    distribution::configurations(root)?;
    println!("PASS: Xcode project generated from the shared Figma icon inventory");
    Ok(())
}

fn xcode(root: &Path) -> Result<()> {
    ensure!(
        cfg!(target_os = "macos"),
        "The iOS gate requires macOS and Xcode"
    );
    let expected = fs::read_to_string(root.join("ios/.xcode-version"))?;
    let xcode = super::checked(Command::new("xcodebuild").arg("-version"))?;
    ensure!(
        String::from_utf8_lossy(&xcode.stdout).lines().next()
            == Some(&format!("Xcode {}", expected.trim())),
        "Select the pinned Xcode {} before running the iOS gate",
        expected.trim()
    );
    Ok(())
}

fn affected(root: &Path, base: &str, output: Option<&Path>) -> Result<()> {
    let changed = if base.is_empty() {
        true
    } else {
        ensure!(
            (base.len() == SHA1_HEX_LENGTH || base.len() == SHA256_HEX_LENGTH)
                && base.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "The iOS change scope requires an exact Git commit identity"
        );
        let status = Command::new("git")
            .current_dir(root)
            .args(["diff", "--quiet", base, "HEAD", "--"])
            .args(SCOPE)
            .status()?;
        match status.code() {
            Some(0) => false,
            Some(1) => true,
            _ => bail!("Git could not establish the iOS change scope"),
        }
    };
    if let Some(path) = output {
        writeln!(
            OpenOptions::new().append(true).open(path)?,
            "changed={changed}"
        )?;
    }
    println!("iOS changes: {changed}");
    Ok(())
}

fn build_number(run_number: u32, run_attempt: u32, output: Option<&Path>) -> Result<()> {
    let number = BuildNumber::from_run(run_number, run_attempt)?;
    if let Some(path) = output {
        writeln!(
            OpenOptions::new().append(true).open(path)?,
            "number={number}"
        )?;
    }
    println!("Build number: {number}");
    Ok(())
}

struct Fixture {
    child: Child,
}

impl Fixture {
    fn start(root: &Path) -> Result<Self> {
        let address = (LOOPBACK_HOST, FIXTURE_PORT);
        let listener = TcpListener::bind(address)
            .context("The iOS fixture requires unused loopback port 3100")?;
        drop(listener);
        let file = fs::File::create(root.join("target/ios/fixture-server.log"))?;
        let child = Command::new("node")
            .current_dir(root)
            .args(["tools/native-fixture.ts", "--serve"])
            .stdout(Stdio::from(file.try_clone()?))
            .stderr(Stdio::from(file))
            .spawn()?;
        let mut fixture = Self { child };
        let deadline = Instant::now() + FIXTURE_READINESS;
        loop {
            ensure!(
                fixture.child.try_wait()?.is_none(),
                "The iOS fixture stopped before becoming ready"
            );
            if let Ok(mut stream) = TcpStream::connect(address) {
                stream.set_read_timeout(Some(Duration::from_secs(1)))?;
                stream.set_write_timeout(Some(Duration::from_secs(1)))?;
                stream.write_all(
                    b"GET /api/datasets HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
                )?;
                let mut bytes = [0; 64];
                if stream
                    .read(&mut bytes)
                    .is_ok_and(|length| bytes[..length].starts_with(b"HTTP/1.1 200"))
                {
                    return Ok(fixture);
                }
            }
            ensure!(
                Instant::now() < deadline,
                "Fixture readiness is inconclusive; inspect target/ios/fixture-server.log"
            );
            thread::sleep(FIXTURE_READINESS_POLL);
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status()
        {
            eprintln!(
                "iOS check: fixture termination request failed; forcing exit after the grace period: {error}"
            );
        }
        let deadline = Instant::now() + FIXTURE_TERMINATION_GRACE;
        while self.child.try_wait().is_ok_and(|status| status.is_none())
            && Instant::now() < deadline
        {
            thread::sleep(FIXTURE_TERMINATION_POLL);
        }
        if self.child.try_wait().is_ok_and(|status| status.is_none())
            && let Err(error) = self.child.kill()
        {
            eprintln!("iOS check: fixture forced exit failed: {error}");
        }
        if let Err(error) = self.child.wait() {
            eprintln!("iOS check: fixture exit status was not collected: {error}");
        }
    }
}

struct Simulator(String);

impl Simulator {
    fn id(&self) -> &str {
        &self.0
    }
}

impl Drop for Simulator {
    fn drop(&mut self) {
        if let Err(error) = Command::new("xcrun")
            .args(["simctl", "shutdown", &self.0])
            .status()
        {
            eprintln!(
                "iOS check: simulator {} shutdown failed; the next run shuts it down before erasing it: {error}",
                self.0
            );
        }
    }
}

fn device(root: &Path) -> Result<Simulator> {
    let output = logged(
        root,
        "simulators",
        Command::new("xcrun").args(["simctl", "list", "devices", "available", "-j"]),
    )?;
    let devices: Value = serde_json::from_slice(&output.stdout)?;
    let existing = devices["devices"][RUNTIME].as_array().and_then(|values| {
        values
            .iter()
            .find(|value| value["name"] == DEVICE_NAME)
            .and_then(|value| value["udid"].as_str())
    });
    let identifier = if let Some(identifier) = existing {
        identifier.to_owned()
    } else {
        let result = logged(
            root,
            "create-simulator",
            Command::new("xcrun").args(["simctl", "create", DEVICE_NAME, DEVICE_TYPE, RUNTIME]),
        )?;
        String::from_utf8(result.stdout)?.trim().to_owned()
    };
    ensure!(
        identifier.len() == SIMULATOR_IDENTIFIER_LENGTH
            && identifier
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-'),
        "The simulator returned an invalid identifier"
    );
    let booted = devices["devices"][RUNTIME]
        .as_array()
        .is_some_and(|values| {
            values
                .iter()
                .any(|value| value["udid"] == identifier && value["state"] == "Booted")
        });
    if booted {
        logged(
            root,
            "shutdown-simulator",
            Command::new("xcrun").args(["simctl", "shutdown", &identifier]),
        )?;
    }
    logged(
        root,
        "erase-test-simulator",
        Command::new("xcrun").args(["simctl", "erase", &identifier]),
    )?;
    let simulator = Simulator(identifier);
    logged(
        root,
        "boot-simulator",
        Command::new("xcrun").args(["simctl", "boot", simulator.id()]),
    )?;
    logged(
        root,
        "simulator-ready",
        Command::new("xcrun").args(["simctl", "bootstatus", simulator.id(), "-b"]),
    )?;
    persist_app_trace(root, simulator.id())?;
    for (key, value) in [
        ("DidShowContinuousPathIntroduction", "true"),
        ("KeyboardContinuousPathEnabled", "false"),
    ] {
        logged(
            root,
            "disable-keyboard-tutorial",
            Command::new("xcrun").args([
                "simctl",
                "spawn",
                simulator.id(),
                "defaults",
                "write",
                "com.apple.Preferences",
                key,
                "-bool",
                value,
            ]),
        )?;
    }
    Ok(simulator)
}

/// Keeps the app's info-level directory trace in the simulator log until the simulator shuts down.
fn persist_app_trace(root: &Path, identifier: &str) -> Result<Output> {
    logged(
        root,
        "simulator-log-config",
        Command::new("xcrun").args([
            "simctl",
            "spawn",
            identifier,
            "log",
            "config",
            "--subsystem",
            failure::APP_SUBSYSTEM,
            "--mode",
            "level:info,persist:info",
        ]),
    )
}

fn ui_command(root: &Path, identifier: &str) -> Command {
    let allowance = SCENARIO_ALLOWANCE_SECONDS.to_string();
    let mut command = Command::new("xcodebuild");
    command.current_dir(root).args([
        "-quiet",
        "-toolchain",
        "com.apple.dt.toolchain.XcodeDefault",
        "-project",
        "ios/PublicPhonebook.xcodeproj",
        "-scheme",
        "PublicPhonebookVerification",
        "-configuration",
        "VerificationDebug",
        "-destination",
        &format!("platform=iOS Simulator,id={identifier}"),
        "-derivedDataPath",
        "ios/DerivedData",
        "-jobs",
        "2",
        "-parallel-testing-enabled",
        "NO",
        "-collect-test-diagnostics",
        "never",
        "-test-timeouts-enabled",
        "YES",
        "-default-test-execution-time-allowance",
        &allowance,
        "-maximum-test-execution-time-allowance",
        &allowance,
    ]);
    command.args([
        "CODE_SIGN_IDENTITY=-",
        "CODE_SIGN_STYLE=Manual",
        "CODE_SIGNING_ALLOWED=YES",
    ]);
    command
}

fn require_ui_case(summary: &Value, tree: &Value, expected: &str) -> Result<()> {
    fn cases(node: &Value, names: &mut Vec<(String, String)>) {
        if node["nodeType"] == "Test Case" {
            names.push((
                node["nodeIdentifier"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                node["result"].as_str().unwrap_or_default().to_owned(),
            ));
        }
        for child in node["children"].as_array().into_iter().flatten() {
            cases(child, names);
        }
    }
    let mut observed = Vec::new();
    for node in tree["testNodes"].as_array().into_iter().flatten() {
        cases(node, &mut observed);
    }
    ensure!(
        summary["failedTests"].as_u64() == Some(0)
            && summary["passedTests"].as_u64() == Some(1)
            && summary["skippedTests"].as_u64() == Some(0)
            && summary["expectedFailures"].as_u64() == Some(0)
            && summary["totalTestCount"].as_u64() == Some(1)
            && summary["result"] == "Passed"
            && summary["runtimeWarnings"]
                .as_array()
                .is_some_and(Vec::is_empty)
            && observed
                == [(
                    format!("DirectoryUITests/{expected}()"),
                    "Passed".to_owned()
                )],
        "The iOS UI gate requires the exact declared test, no skips or runtime warnings, and a successful result"
    );
    Ok(())
}

fn plist_string(path: &Path, key: &str) -> Result<String> {
    let output = super::checked(
        Command::new("plutil")
            .args(["-extract", key, "raw", "-o", "-"])
            .arg(path),
    )?;
    let value = String::from_utf8(output.stdout)?.trim().to_owned();
    ensure!(
        !value.is_empty(),
        "The built test configuration is missing {key}"
    );
    Ok(value)
}

/// Requires that the main run left out the footprint test and that the isolated run passed it alone.
fn require_isolated_footprint(main: &str, isolated: &str) -> Result<()> {
    let name = format!("Test {ISOLATED_FOOTPRINT_TEST}()");
    ensure!(
        !main.lines().any(|line| line.contains(&name)),
        "The main Swift test run included {ISOLATED_FOOTPRINT_TEST}, which shares its process with concurrent tests"
    );
    ensure!(
        isolated
            .lines()
            .any(|line| line.starts_with(&format!("✔ {name} passed after ")))
            && isolated
                .lines()
                .any(|line| line.contains("Test run with 1 test ")
                    && line.contains(" passed after ")),
        "The isolated Swift test run did not pass {ISOLATED_FOOTPRINT_TEST} alone"
    );
    Ok(())
}

/// Requires that a sanitizer run passed the tests that drive untrusted bytes, bounded buffers, and cancellation through the code.
fn require_sanitized_contracts(output: &str) -> Result<()> {
    for contract in SANITIZED_CONTRACTS {
        ensure!(
            output
                .lines()
                .any(|line| line.starts_with(&format!("✔ Test {contract}() "))
                    && line.contains(" passed after ")),
            "Sanitizer gate did not pass required behavioral test {contract}"
        );
    }
    Ok(())
}

/// Removes the footprint test from a test enumeration, and refuses an enumeration that lacks it.
fn without_isolated_footprint(list: &str) -> Result<String> {
    let suffix = format!(".{ISOLATED_FOOTPRINT_TEST}()");
    let (removed, kept): (Vec<&str>, Vec<&str>) = list
        .lines()
        .partition(|line| line.trim().ends_with(&suffix));
    ensure!(
        removed.len() == 1,
        "The Swift test enumeration lists {ISOLATED_FOOTPRINT_TEST} {} times instead of once",
        removed.len()
    );
    Ok(kept.join("\n"))
}

fn require_unit_inventory(list: &str, log: &str) -> Result<usize> {
    let mut expected = BTreeSet::new();
    for identifier in list.lines().filter(|line| !line.trim().is_empty()) {
        ensure!(
            identifier.starts_with("PhonebookCoreTests.")
                || identifier.starts_with("PhonebookKitTests."),
            "Unexpected Swift test enumeration entry"
        );
        let (_, name) = identifier
            .split_once('.')
            .context("Missing Swift test identifier")?;
        ensure!(
            name.ends_with(')') && expected.insert(name),
            "Invalid or ambiguous Swift test enumeration"
        );
    }
    let passed = log
        .lines()
        .filter(|line| line.starts_with("✔ Test ") && line.contains(" passed after "))
        .filter_map(|line| line.strip_prefix("✔ Test ")?.split_whitespace().next())
        .filter(|name| name.ends_with(')'))
        .collect::<Vec<_>>();
    let count: usize = log
        .lines()
        .filter_map(|line| line.split_once("Test run with "))
        .filter_map(|(_, rest)| rest.split_whitespace().next()?.parse::<usize>().ok())
        .sum();
    ensure!(
        !expected.is_empty()
            && count == expected.len()
            && passed.len() == expected.len()
            && passed.into_iter().collect::<BTreeSet<_>>() == expected,
        "The Swift gate requires every compiled test to pass once, without skips or substitutions"
    );
    Ok(count)
}

struct UiEvidence {
    directory: PathBuf,
    count: usize,
}

fn require_ui_inventory(inventory: &Value) -> Result<()> {
    let values = inventory["values"]
        .as_array()
        .context("UI test enumeration has no plans")?;
    let mut names = Vec::new();
    for plan in values {
        ensure!(
            plan["disabledTests"].as_array().is_some_and(Vec::is_empty),
            "The compiled UI inventory disables tests"
        );
        for test in plan["enabledTests"]
            .as_array()
            .context("UI plan has no enabled tests")?
        {
            names.push(
                test["identifier"]
                    .as_str()
                    .context("UI test identifier missing")?
                    .to_owned(),
            );
        }
    }
    let expected = UI_TESTS
        .iter()
        .copied()
        .chain([LIVE_UI_TEST])
        .map(|name| format!("PhonebookUITests/DirectoryUITests/{name}()"))
        .collect::<BTreeSet<_>>();
    ensure!(
        inventory["errors"].as_array().is_some_and(Vec::is_empty)
            && names.len() == expected.len()
            && names.into_iter().collect::<BTreeSet<_>>() == expected,
        "The compiled UI inventory differs from its declared controlled and live cases"
    );
    Ok(())
}

fn ui_test(root: &Path, selected: &[String], live: bool) -> Result<UiEvidence> {
    ensure!(
        selected
            .iter()
            .all(|name| UI_TESTS.contains(&name.as_str()))
            && selected.iter().collect::<BTreeSet<_>>().len() == selected.len(),
        "Select distinct declared iOS UI test names"
    );
    let receipt = root.join(if live {
        "target/ios/live-ui-receipt.json"
    } else {
        "target/ios/ui-receipt.json"
    });
    if receipt.exists() {
        fs::remove_file(&receipt)?;
    }
    let evidence = root.join(failure::EVIDENCE);
    if evidence.exists() {
        fs::remove_dir_all(&evidence)?;
    }
    let sources = source_hashes(root)?;
    let _fixture = if live {
        None
    } else {
        Some(Fixture::start(root)?)
    };
    let simulator = device(root)?;
    let identifier = simulator.id().to_owned();
    let directory = tempfile::Builder::new()
        .prefix("ui-")
        .tempdir_in(root.join("target/ios"))?
        .keep();
    logged(
        root,
        "ui-build",
        ui_command(root, &identifier).arg("build-for-testing"),
    )?;
    let inventory = logged(
        root,
        "ui-inventory",
        ui_command(root, &identifier).args([
            "-enumerate-tests",
            "-test-enumeration-format",
            "json",
            "-test-enumeration-style",
            "flat",
            "-test-enumeration-output-path",
            "-",
            "test-without-building",
        ]),
    )?;
    require_ui_inventory(&serde_json::from_slice(&inventory.stdout)?)?;
    let products = root.join("ios/DerivedData/Build/Products/VerificationDebug-iphonesimulator");
    let application = products.join("PublicPhonebook.app");
    let runner = products.join("PhonebookUITests-Runner.app");
    let bundle = plist_string(&application.join("Info.plist"), "CFBundleIdentifier")?;
    plist_string(&runner.join("Info.plist"), "CFBundleIdentifier")?;
    let names = if live {
        vec![LIVE_UI_TEST]
    } else if selected.is_empty() {
        UI_TESTS.to_vec()
    } else {
        selected.iter().map(String::as_str).collect()
    };
    let mut completed = Vec::new();
    let mut recoveries = Vec::new();
    let mut previous = SystemTime::now();
    for name in names {
        {
            let case = name.to_owned();
            let state = failure::simulator_state(&identifier, &failure::Xcode)?;
            if state != failure::BOOTED {
                let evidence = failure::keep_host_state(
                    root,
                    &format!("simulator-before-{case}"),
                    previous,
                    &failure::Xcode,
                )?;
                println!(
                    "iOS check: the simulator was {state} before {case}; host evidence: {evidence}"
                );
                recoveries.push(json!({"before":case,"state":state,"evidence":evidence}));
                ensure!(
                    recoveries.len() <= failure::MAX_SIMULATOR_RECOVERIES,
                    "The simulator left the booted state {} times; inspect {evidence}",
                    recoveries.len()
                );
                logged(
                    root,
                    "recover-simulator",
                    Command::new("xcrun").args(["simctl", "bootstatus", &identifier, "-b"]),
                )?;
                persist_app_trace(root, &identifier)?;
            }
            if !completed.is_empty() {
                logged(
                    root,
                    "reset-ui-application",
                    Command::new("xcrun").args(["simctl", "uninstall", &identifier, &bundle]),
                )?;
            }
            logged(
                root,
                "install-ui-application",
                Command::new("xcrun")
                    .args(["simctl", "install", &identifier])
                    .arg(&application),
            )?;
            let result = directory.join(format!("{case}.xcresult"));
            let started = SystemTime::now();
            previous = started;
            let execution = logged(
                root,
                &case,
                ui_command(root, &identifier)
                    .arg("-resultBundlePath")
                    .arg(&result)
                    .arg(format!(
                        "-only-testing:PhonebookUITests/DirectoryUITests/{name}"
                    ))
                    .arg("test-without-building"),
            );
            let read_result = |kind| -> Result<Value> {
                let output = logged(
                    root,
                    &format!("{case}-{kind}"),
                    Command::new("xcrun")
                        .args(["xcresulttool", "get", "test-results", kind, "--path"])
                        .arg(&result),
                )?;
                Ok(serde_json::from_slice(&output.stdout)?)
            };
            let verdict = execution.and_then(|_| {
                require_ui_case(&read_result("summary")?, &read_result("tests")?, name)
            });
            let error = verdict.as_ref().err().map(|error| format!("{error:#}"));
            let mut hung = error.as_deref().is_some_and(exceeded_allowance);
            let evidence = error.as_ref().map(|error| {
                println!("FAIL: {case}: {error}");
                let scenario = failure::Scenario {
                    root,
                    simulator: &identifier,
                    name,
                    bundle: &result,
                    started,
                };
                match failure::keep(&scenario, &failure::Xcode) {
                    Ok(kept) => {
                        hung |= kept
                            .failures
                            .iter()
                            .any(|failed| exceeded_allowance(&failed.text));
                        for failed in &kept.failures {
                            println!("  failure: {}", failed.text);
                            for location in &failed.locations {
                                println!("    at {location}");
                            }
                        }
                        for gap in &kept.errors {
                            println!("  evidence gap: {gap}");
                        }
                        println!("  evidence: {}", kept.directory);
                        kept.record()
                    }
                    Err(error) => {
                        println!("  evidence was not kept: {error:#}");
                        json!({"error":format!("{error:#}")})
                    }
                }
            });
            if error.is_none() {
                println!("PASS: {case}");
            }
            let outcome = scenario_outcome(verdict.is_ok(), hung);
            if outcome == INCONCLUSIVE {
                println!(
                    "INCONCLUSIVE: {case} reached its {SCENARIO_ALLOWANCE_SECONDS} s hang guard"
                );
            }
            completed.push(json!({
                "test":name,
                "result":outcome,
                "error":error,"bundle":result,"evidence":evidence
            }));
        }
    }
    require_current_sources(root, &sources)?;
    let count = |outcome: &str| {
        completed
            .iter()
            .filter(|case| case["result"] == outcome)
            .count()
    };
    let (failed, inconclusive) = (count(FAILED), count(INCONCLUSIVE));
    fs::write(
        receipt,
        serde_json::to_vec_pretty(&json!({
        "result":if failed > 0 { FAILED } else if inconclusive > 0 { INCONCLUSIVE } else { PASSED }, "complete_controlled_inventory":selected.is_empty() && !live,
        "api_environment":if live { "configured public service" } else { "controlled real service fixture" },
        "live_api_origin":if live { Some(plist_string(&application.join("Info.plist"), "PhonebookAPIOrigin")?) } else { None },
            "tests":completed, "simulator_recoveries":recoveries, "source_sha256":source_records(&sources),
            "state_isolation":"dedicated erased simulator; application reinstalled before every scenario",
            "simulator_runtime":RUNTIME, "simulator_device":DEVICE_TYPE,
            "physical_device":"not run", "background_scope":"foreground/background UI transitions, not discretionary BGTaskScheduler delivery"
        }))?,
    )?;
    ensure!(
        failed == 0,
        "{failed} native iOS UI scenarios failed; inspect {}",
        evidence.display()
    );
    ensure!(
        inconclusive == 0,
        "Inconclusive: {inconclusive} native iOS UI scenarios reached their {SCENARIO_ALLOWANCE_SECONDS} s hang guard; inspect {}",
        evidence.display()
    );
    println!(
        "PASS: {} native iOS UI scenarios; {}",
        completed.len(),
        directory.display()
    );
    Ok(UiEvidence {
        directory,
        count: completed.len(),
    })
}

pub fn run(root: &Path, action: Action) -> Result<()> {
    if matches!(action, Action::Audit) {
        return super::audit(root);
    }
    if let Action::Icons { import, check } = action {
        return super::icons::run(root, import.as_deref(), check);
    }
    if let Action::Affected { base, output } = action {
        return affected(root, &base, output.as_deref());
    }
    if let Action::BuildNumber {
        run_number,
        run_attempt,
        output,
    } = action
    {
        return build_number(run_number, run_attempt, output.as_deref());
    }
    if let Action::Archive {
        require_receipts,
        build_number,
        signing,
    } = &action
    {
        signing::admit_request(
            *signing,
            *require_receipts,
            build_number.map(BuildNumber::new).transpose()?,
        )?;
    }
    let _machine_lease = (!matches!(action, Action::Prove | Action::UnitTest))
        .then(lease::MachineLease::acquire)
        .transpose()?;
    let checkout_lock = match &action {
        Action::Prove => Some("target/ios/proof.lock"),
        Action::Sanitize => Some("target/ios/sanitizer.lock"),
        Action::Mutate => Some("target/ios/mutation.lock"),
        Action::UnitTest => Some("target/ios/unit-command.lock"),
        _ => None,
    };
    let _checkout_lease = checkout_lock
        .map(|lock| GateLease::acquire(&root.join(lock)))
        .transpose()?;
    if matches!(action, Action::Prove) {
        return proof::run(root);
    }
    if matches!(action, Action::Sanitize) {
        xcode(root)?;
        return sanitize(root);
    }
    if matches!(action, Action::Mutate) {
        xcode(root)?;
        return mutation::run(root);
    }
    let receipt = root.join("target/ios/receipt.json");
    if matches!(&action, Action::Check) && receipt.exists() {
        fs::remove_file(&receipt)?;
    }
    xcode(root)?;
    if matches!(action, Action::Testflight) {
        return testflight::run(root);
    }
    let unit_only = matches!(action, Action::UnitTest);
    if !unit_only {
        generate(root)?;
    }
    match action {
        Action::Archive {
            require_receipts,
            build_number,
            signing,
        } => distribution::archive(
            root,
            &distribution::ArchiveRequest {
                signing,
                require_receipts,
                build: build_number.map(BuildNumber::new).transpose()?,
            },
        ),
        Action::Screenshots { origin } => screenshots::capture(root, &origin),
        Action::Generate => Ok(()),
        Action::StoreBuildControl => store_build::control(root),
        Action::UiTest { tests, live } => {
            ui_test(root, &tests, live)?;
            Ok(())
        }
        Action::Check | Action::UnitTest => {
            let unit_lease = GateLease::acquire(&root.join("target/ios/unit.lock"))?;
            let unit_receipt = root.join("target/ios/unit-receipt.json");
            if unit_receipt.exists() {
                fs::remove_file(&unit_receipt)?;
            }
            let sources = source_hashes(root)?;
            logged(
                root,
                "swiftlint",
                Command::new("swiftlint")
                    .current_dir(root.join("ios"))
                    .args(["lint", "--strict", "--config", ".swiftlint.yml"]),
            )?;
            logged(
                root,
                "swift-format",
                Command::new("xcrun").current_dir(root).args([
                    "swift-format",
                    "lint",
                    "--strict",
                    "--recursive",
                    "ios/App",
                    "ios/Native",
                    "ios/CallDirectory",
                    "ios/Sources",
                    "ios/Tests",
                    "ios/UITests",
                    "ios/Package.swift",
                ]),
            )?;
            let unit = logged(
                root,
                "unit-tests",
                Command::new("xcrun").current_dir(root).args([
                    "swift",
                    "test",
                    "--package-path",
                    "ios",
                    "--jobs",
                    "2",
                    "--enable-code-coverage",
                    "--skip",
                    ISOLATED_FOOTPRINT_TEST,
                    "-Xswiftc",
                    "-warnings-as-errors",
                ]),
            )?;
            let mut log = String::from_utf8_lossy(&unit.stdout).into_owned();
            log.push_str(&String::from_utf8_lossy(&unit.stderr));
            // The coverage data stays the main run's, because this run writes its profile elsewhere.
            let isolated = logged(
                root,
                "unit-isolated-footprint",
                Command::new("xcrun")
                    .current_dir(root)
                    .env(ISOLATED_FOOTPRINT_VARIABLE, "1")
                    .env(
                        "LLVM_PROFILE_FILE",
                        root.join("target/ios/unit-isolated-footprint-%p.profraw"),
                    )
                    .args([
                        "swift",
                        "test",
                        "--package-path",
                        "ios",
                        "--skip-build",
                        "--filter",
                        ISOLATED_FOOTPRINT_TEST,
                    ]),
            )?;
            let isolated_log = format!(
                "{}{}",
                String::from_utf8_lossy(&isolated.stdout),
                String::from_utf8_lossy(&isolated.stderr)
            );
            require_isolated_footprint(&log, &isolated_log)?;
            log.push_str(&isolated_log);
            for harness in REQUIRED_TESTS {
                ensure!(
                    log.lines()
                        .any(|line| line.contains(&format!("Test {harness}"))
                            && line.contains("passed")),
                    "The iOS gate did not execute required finite check {harness}"
                );
            }
            let coverage = coverage(root)?;
            let inventory = logged(
                root,
                "unit-inventory",
                Command::new("xcrun")
                    .current_dir(root)
                    .env(
                        "LLVM_PROFILE_FILE",
                        root.join("target/ios/unit-inventory-%p.profraw"),
                    )
                    .args([
                        "swift",
                        "test",
                        "list",
                        "--package-path",
                        "ios",
                        "--skip-build",
                    ]),
            )?;
            let unit_tests = require_unit_inventory(&String::from_utf8(inventory.stdout)?, &log)?;
            ensure!(
                unit_tests >= REQUIRED_TESTS.len(),
                "The Swift test run was empty"
            );
            require_current_sources(root, &sources)?;
            fs::write(
                unit_receipt,
                serde_json::to_vec_pretty(&json!({
                    "result":"passed","unit_tests":unit_tests,"required_contracts":REQUIRED_TESTS.as_slice(),
                    "coverage":coverage,"source_sha256":source_records(&sources),
                    "scope":"strict Swift lints and all compiled macOS Swift package tests; excludes app and extension execution"
                }))?,
            )?;
            drop(unit_lease);
            if unit_only {
                println!(
                    "PASS: {unit_tests} Swift tests; complete compiled inventory, strict lints, and production coverage"
                );
                return Ok(());
            }
            logged(
                root,
                "simulator-build",
                Command::new("xcodebuild").current_dir(root).args([
                    "-quiet",
                    "-toolchain",
                    "com.apple.dt.toolchain.XcodeDefault",
                    "-project",
                    "ios/PublicPhonebook.xcodeproj",
                    "-scheme",
                    "PublicPhonebook",
                    "-configuration",
                    "VerificationDebug",
                    "-destination",
                    "generic/platform=iOS Simulator",
                    "-derivedDataPath",
                    "ios/DerivedData",
                    "-jobs",
                    "2",
                    "CODE_SIGNING_ALLOWED=NO",
                    "build",
                ]),
            )?;
            let executable = root.join("ios/DerivedData/Build/Products/VerificationDebug-iphonesimulator/PublicPhonebook.app/PublicPhonebook");
            ensure!(
                executable.is_file(),
                "The iOS gate produced no app executable"
            );
            logged(
                root,
                "device-build",
                Command::new("xcodebuild").current_dir(root).args([
                    "-quiet",
                    "-toolchain",
                    "com.apple.dt.toolchain.XcodeDefault",
                    "-project",
                    "ios/PublicPhonebook.xcodeproj",
                    "-scheme",
                    "PublicPhonebook",
                    "-configuration",
                    "Release",
                    "-destination",
                    "generic/platform=iOS",
                    "-derivedDataPath",
                    "ios/DerivedData",
                    "-jobs",
                    "2",
                    "CODE_SIGNING_ALLOWED=NO",
                    "build",
                ]),
            )?;
            store_build::require_absent(
                &root.join("ios/DerivedData/Build/Products/Release-iphoneos/PublicPhonebook.app"),
            )?;
            store_build::require_every_marker(
                &root.join(
                    "ios/DerivedData/Build/Products/VerificationDebug-iphonesimulator/PublicPhonebook.app",
                ),
                "VerificationDebug",
            )?;
            app_info::check_built(
                root,
                &root.join(
                    "ios/DerivedData/Build/Products/VerificationDebug-iphonesimulator/PublicPhonebook.app",
                ),
                "VerificationDebug",
            )?;
            app_info::check_built(
                root,
                &root.join("ios/DerivedData/Build/Products/Release-iphoneos/PublicPhonebook.app"),
                "Release",
            )?;
            let results = ui_test(root, &[], false)?;
            require_current_sources(root, &sources)?;
            fs::write(
                receipt,
                serde_json::to_vec_pretty(&json!({
                    "result":"passed",
                    "xcode":fs::read_to_string(root.join("ios/.xcode-version"))?.trim(),
                    "ui_results":results.directory, "ui_tests":results.count, "finite_feed_inputs":FINITE_FEED_INPUTS, "finite_publication_inputs":FINITE_PUBLICATION_INPUTS,
                    "publication_transitions":PUBLICATION_TRANSITIONS, "receive_budget_boundary_cases":RECEIVE_BUDGET_BOUNDARY_CASES,
                    "delta_admission_cases":DELTA_ADMISSION_CASES,
                    "unit_tests":unit_tests, "coverage":coverage,
                    "source_sha256":source_records(&sources),
                    "swift_language_mode":"6", "deployment_target":"iOS 18.0",
                    "device_build":"Release, unsigned",
                    "store_build":format!("Release app and extension contain none of the {} verification tools markers, and VerificationDebug contains all of them", store_build::MARKERS.len()),
                    "simulator_runtime":RUNTIME, "simulator_device":DEVICE_TYPE,
                    "device_validation":"not run", "ios_18_runtime_validation":"not run"
                }))?,
            )?;
            println!(
                "PASS: native iOS gate; finite decisions, behavioral contracts, all app targets, and UI flows"
            );
            Ok(())
        }
        Action::Affected { .. } => bail!("The iOS change scope was not handled"),
        Action::BuildNumber { .. } => bail!("The build number was not handled"),
        Action::Testflight => bail!("The TestFlight delivery was not handled"),
        Action::Prove => bail!("The iOS proof gate was not handled"),
        Action::Sanitize => bail!("The iOS sanitizer gate was not handled"),
        Action::Mutate => bail!("The iOS mutation gate was not handled"),
        Action::Icons { .. } => bail!("The shared icon gate was not handled"),
        Action::Audit => bail!("The dependency audit was not handled"),
    }
}

fn sanitize(root: &Path) -> Result<()> {
    let receipt = root.join("target/ios/sanitizer-receipt.json");
    if receipt.exists() {
        fs::remove_file(&receipt)?;
    }
    let sources = source_hashes(root)?;
    for sanitizer in ["address", "thread"] {
        let result = logged(
            root,
            &format!("sanitize-{sanitizer}"),
            Command::new("xcrun")
                .current_dir(root)
                .args(["swift", "test", "--package-path", "ios", "--scratch-path"])
                .arg(root.join(format!("target/ios/sanitize-{sanitizer}")))
                .args(["--sanitize", sanitizer, "--jobs", "2"])
                // A sanitizer's shadow memory and quarantine make the footprint meaningless, and the bounded-buffer test covers the reader's code here.
                .args(["--skip", ISOLATED_FOOTPRINT_TEST]),
        )?;
        let output = format!(
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        require_sanitized_contracts(&output)?;
        let inventory = logged(
            root,
            &format!("sanitize-{sanitizer}-inventory"),
            Command::new("xcrun")
                .current_dir(root)
                .env(
                    "LLVM_PROFILE_FILE",
                    root.join(format!(
                        "target/ios/sanitize-{sanitizer}-inventory-%p.profraw"
                    )),
                )
                .args([
                    "swift",
                    "test",
                    "list",
                    "--package-path",
                    "ios",
                    "--scratch-path",
                ])
                .arg(root.join(format!("target/ios/sanitize-{sanitizer}")))
                .args(["--sanitize", sanitizer, "--skip-build"]),
        )?;
        require_unit_inventory(
            &without_isolated_footprint(&String::from_utf8(inventory.stdout)?)?,
            &output,
        )?;
    }
    require_current_sources(root, &sources)?;
    fs::write(
        receipt,
        serde_json::to_vec_pretty(
            &json!({"result":"passed", "sanitizers":["address","thread"], "source_sha256":source_records(&sources), "boundary":"macOS Swift production package and tests; Apple SQLite and SDK binaries are not rebuilt"}),
        )?,
    )?;
    println!("PASS: AddressSanitizer and ThreadSanitizer over production Swift package");
    Ok(())
}

fn coverage(root: &Path) -> Result<Value> {
    let result = logged(
        root,
        "coverage-path",
        Command::new("xcrun").current_dir(root).args([
            "swift",
            "test",
            "--package-path",
            "ios",
            "--show-codecov-path",
        ]),
    )?;
    let path = String::from_utf8(result.stdout)?.trim().to_owned();
    ensure!(
        Path::new(&path).starts_with(root.join("ios/.build")),
        "Coverage output escaped the package build directory"
    );
    let directory = Path::new(&path)
        .parent()
        .context("Coverage directory missing")?;
    let products = directory
        .parent()
        .context("Swift test product directory missing")?;
    let mut export = Command::new("xcrun");
    export
        .current_dir(root)
        .args(["llvm-cov", "export", "-instr-profile"])
        .arg(directory.join("default.profdata"))
        .arg(products.join("PhonebookKitTests.xctest/Contents/MacOS/PhonebookKitTests"))
        .arg("-object")
        .arg(products.join("PhonebookCoreTests.xctest/Contents/MacOS/PhonebookCoreTests"));
    let output = logged(root, "coverage-export", &mut export)?;
    let report: Value = serde_json::from_slice(&output.stdout)?;
    let files = report["data"].as_array().context("No coverage data")?.iter()
        .flat_map(|data| data["files"].as_array().into_iter().flatten())
        .filter(|file| file["filename"].as_str().is_some_and(|name| name.contains("/ios/Sources/")))
        .map(|file| json!({"file":file["filename"].as_str().and_then(|name| name.split_once("/ios/")).map(|(_, name)| name), "lines":file["summary"]["lines"], "functions":file["summary"]["functions"]}))
        .collect::<Vec<_>>();
    ensure!(
        files
            .iter()
            .any(|file| file["file"] == "Sources/PhonebookKit/SyncEngine.swift")
            && files
                .iter()
                .any(|file| file["file"] == "Sources/PhonebookCore/PublicationPhase.swift"),
        "Production coverage omitted an owning test binary"
    );
    let summary = json!({"scope":"Swift package production sources; excludes native app and Apple frameworks", "files":files});
    fs::write(
        root.join("target/ios/coverage.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_exceeded_allowance_makes_a_failed_scenario_inconclusive() {
        // XCTestCore's format: "Test Case '%@' exceeded execution time allowance of %@. The test may have hung; ..."
        assert!(exceeded_allowance(
            "Test Case '-[PhonebookUITests.DirectoryUITests testLivePublicDirectorySearchAndSource]' exceeded execution time allowance of 10 minutes. The test may have hung; check Xcode's test report for more details."
        ));
        assert!(!exceeded_allowance(
            "XCTAssertTrue failed - the start button appears"
        ));
        assert_eq!(scenario_outcome(true, false), PASSED);
        assert_eq!(scenario_outcome(true, true), PASSED);
        assert_eq!(scenario_outcome(false, false), FAILED);
        assert_eq!(scenario_outcome(false, true), INCONCLUSIVE);
    }

    #[test]
    fn unit_inventory_rejects_missing_skipped_duplicate_and_substituted_tests() -> Result<()> {
        let list = "PhonebookCoreTests.first()\nPhonebookKitTests.second(_:)\n";
        let log = "✔ Test first() passed after 0.1 seconds.\n✔ Test second(_:) with 16 test cases passed after 1.0 seconds.\n✔ Test run with 2 tests in 0 suites passed after 1.1 seconds.\n";
        assert_eq!(require_unit_inventory(list, log)?, 2);
        for invalid in [
            log.replace("✔ Test first() passed after 0.1 seconds.\n", ""),
            log.replace("✔ Test first() passed", "↷ Test first() skipped"),
            log.replace("first()", "unexpected()"),
            log.replace("with 2 tests", "with 0 tests"),
            format!("{log}✔ Test first() passed after 0.1 seconds.\n"),
        ] {
            assert!(require_unit_inventory(list, &invalid).is_err());
        }
        assert!(require_unit_inventory("", log).is_err());
        assert!(
            require_unit_inventory("PhonebookCoreTests.first()\nPhonebookKitTests.first()", log)
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn isolated_footprint_runs_alone_and_only_in_its_own_invocation() -> Result<()> {
        let main = "✔ Test first() passed after 0.1 seconds.\n✔ Test run with 1 test in 0 suites passed after 0.1 seconds.\n";
        let isolated = format!(
            "◇ Test run started.\n✔ Test {ISOLATED_FOOTPRINT_TEST}() passed after 0.4 seconds.\n✔ Test run with 1 test in 0 suites passed after 0.4 seconds.\n"
        );
        require_isolated_footprint(main, &isolated)?;
        let shared = format!("{main}{isolated}");
        assert!(require_isolated_footprint(&shared, &isolated).is_err());
        let skipped = format!("{main}➜ Test {ISOLATED_FOOTPRINT_TEST}() skipped.\n");
        assert!(require_isolated_footprint(&skipped, &isolated).is_err());
        for invalid in [
            isolated.replace(
                " passed after 0.4 seconds.\n✔ Test run",
                " failed after 0.4 seconds.\n✔ Test run",
            ),
            isolated.replace("with 1 test ", "with 2 tests "),
            isolated.replace(ISOLATED_FOOTPRINT_TEST, "readerBufferStaysBounded"),
            String::new(),
        ] {
            assert!(require_isolated_footprint(main, &invalid).is_err());
        }
        Ok(())
    }

    #[test]
    fn sanitizer_requires_each_contract_to_pass_not_merely_start() -> Result<()> {
        let passed = SANITIZED_CONTRACTS
            .iter()
            .map(|name| {
                format!("◇ Test {name}() started.\n✔ Test {name}() passed after 0.1 seconds.\n")
            })
            .collect::<String>();
        require_sanitized_contracts(&passed)?;
        let started = SANITIZED_CONTRACTS
            .iter()
            .map(|name| format!("◇ Test {name}() started.\n"))
            .collect::<String>();
        assert!(require_sanitized_contracts(&started).is_err());
        let failed = passed.replacen(" passed after ", " failed after ", 1);
        assert!(require_sanitized_contracts(&failed).is_err());
        assert!(require_sanitized_contracts("").is_err());
        Ok(())
    }

    #[test]
    fn sanitizer_inventory_drops_exactly_the_isolated_footprint_test() -> Result<()> {
        let list = format!(
            "PhonebookCoreTests.first()\nPhonebookCoreTests.{ISOLATED_FOOTPRINT_TEST}()\nPhonebookKitTests.second()"
        );
        assert_eq!(
            without_isolated_footprint(&list)?,
            "PhonebookCoreTests.first()\nPhonebookKitTests.second()"
        );
        assert!(without_isolated_footprint("PhonebookCoreTests.first()").is_err());
        assert!(without_isolated_footprint(&format!("{list}\n{list}")).is_err());
        Ok(())
    }

    #[test]
    fn logged_commands_never_receive_the_signing_secrets() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let mut command = Command::new("env");
        for secret in SECRET_ENVIRONMENT {
            command.env(secret, "probe-secret-value");
        }
        command.env("PHONEBOOK_PROBE_VISIBLE", "probe-visible-value");
        let output = logged(directory.path(), "environment-probe", &mut command)?;
        let environment = String::from_utf8(output.stdout)?;
        assert!(environment.contains("probe-visible-value"));
        assert!(!environment.contains("probe-secret-value"));
        assert!(
            !fs::read_to_string(directory.path().join("target/ios/environment-probe.log"))?
                .contains("probe-secret-value")
        );
        Ok(())
    }

    #[test]
    fn gate_leases_refuse_overlap_and_release_on_drop() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("gate.lock");
        for _ in 0..64 {
            let first = GateLease::acquire(&path)?;
            assert!(GateLease::acquire(&path).is_err());
            drop(first);
            let _next = GateLease::acquire(&path)?;
        }
        Ok(())
    }

    #[test]
    fn ui_inventory_rejects_missing_wrong_duplicate_failed_and_skipped_cases() -> Result<()> {
        let summary = json!({"failedTests":0,"passedTests":1,"skippedTests":0,"expectedFailures":0,"totalTestCount":1,"result":"Passed","runtimeWarnings":[]});
        for name in UI_TESTS {
            let case = json!({"nodeType":"Test Case","nodeIdentifier":format!("DirectoryUITests/{name}()"),"result":"Passed"});
            let tree = json!({"testNodes":[{"children":[case.clone()]}]});
            require_ui_case(&summary, &tree, name)?;
            assert!(require_ui_case(&summary, &json!({"testNodes":[]}), name).is_err());
            assert!(require_ui_case(&summary, &tree, "testUnexpectedCase").is_err());
            assert!(
                require_ui_case(&summary, &json!({"testNodes":[case.clone(),case]}), name).is_err()
            );
            for field in [
                "failedTests",
                "passedTests",
                "skippedTests",
                "expectedFailures",
                "totalTestCount",
            ] {
                let mut invalid = summary.clone();
                invalid[field] = json!(2);
                assert!(require_ui_case(&invalid, &tree, name).is_err());
            }
            let mut failed = tree.clone();
            failed["testNodes"][0]["children"][0]["result"] = json!("Failed");
            assert!(require_ui_case(&summary, &failed, name).is_err());
            let mut warning = summary.clone();
            warning["runtimeWarnings"] = json!([{"message":"Invalid frame dimension"}]);
            assert!(require_ui_case(&warning, &tree, name).is_err());
        }
        Ok(())
    }

    #[test]
    fn compiled_ui_inventory_requires_every_declared_case_without_exclusions() -> Result<()> {
        let enabled = UI_TESTS
            .iter()
            .copied()
            .chain([LIVE_UI_TEST])
            .map(|name| json!({"identifier":format!("PhonebookUITests/DirectoryUITests/{name}()")}))
            .collect::<Vec<_>>();
        let inventory = json!({"errors":[],"values":[{"enabledTests":enabled,"disabledTests":[]}]});
        require_ui_inventory(&inventory)?;
        let mut missing = inventory.clone();
        missing["values"][0]["enabledTests"]
            .as_array_mut()
            .context("Test inventory missing")?
            .pop();
        assert!(require_ui_inventory(&missing).is_err());
        let mut disabled = inventory.clone();
        disabled["values"][0]["disabledTests"] = json!([{"identifier":"ignored"}]);
        assert!(require_ui_inventory(&disabled).is_err());
        let mut errors = inventory.clone();
        errors["errors"] = json!(["enumeration failed"]);
        assert!(require_ui_inventory(&errors).is_err());
        let mut duplicated = inventory.clone();
        duplicated["values"][0]["enabledTests"][1] =
            duplicated["values"][0]["enabledTests"][0].clone();
        assert!(require_ui_inventory(&duplicated).is_err());
        Ok(())
    }

    #[test]
    fn receipts_reject_modified_added_and_removed_inputs() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let root = directory.path();
        super::super::checked(
            Command::new("git")
                .current_dir(root)
                .args(["init", "--quiet"]),
        )?;
        fs::create_dir_all(root.join("ios/Sources"))?;
        let source = root.join("ios/Sources/Contract.swift");
        fs::write(&source, "enum Contract { case retain }")?;
        let initial = source_hashes(root)?;
        require_current_sources(root, &initial)?;
        fs::write(&source, "enum Contract { case publish }")?;
        assert!(require_current_sources(root, &initial).is_err());
        let modified = source_hashes(root)?;
        let added = root.join("ios/Sources/Adapter.swift");
        fs::write(&added, "struct Adapter {}")?;
        assert!(require_current_sources(root, &modified).is_err());
        let expanded = source_hashes(root)?;
        fs::remove_file(added)?;
        assert!(require_current_sources(root, &expanded).is_err());
        Ok(())
    }
}
