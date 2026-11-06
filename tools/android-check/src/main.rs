use anyhow::{Context, Result, bail, ensure};
use base64::Engine as _;
use clap::{Parser, Subcommand};
use contract::{
    BROTLI_PROJECT_URL, COMPILE_ANDROID_API, IO_BUFFER_BYTES, MAXIMUM_CONTACTS,
    MAXIMUM_TRANSFER_BYTES, MINIMUM_ANDROID_API, SERVICE_ORIGIN, SHA256_HEX_CHARACTERS,
    TIMEOUT_EXIT_CODE,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Output},
};

mod contract;
mod device;
mod distribution;
mod mutation;

const BUILD_INPUT_PATHS: &[&str] = &[
    "android",
    "tools/android-check",
    "tools/delivery",
    "ios/Tests/PhonebookCoreTests/SearchContract.json",
    "ios/Tests/PhonebookKitTests/DirectoryContract.json",
    "src/core/kanji-variants.ts",
    "LICENSE-APACHE",
    "mise.toml",
    "mise.lock",
];

#[derive(Parser)]
#[command(about = "Build and verify the offline Android directory")]
struct Arguments {
    #[command(subcommand)]
    action: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Mutate policy bytecode and the declared adapter contracts in an isolated checkout.
    Mutate {
        #[arg(long)]
        plan: bool,
        #[arg(long)]
        select: Vec<String>,
    },
    /// Render or verify the store graphics from their vector sources.
    StoreAssets {
        #[arg(long)]
        check: bool,
    },
    /// Run device tests and retain artifact-bound metrics and screenshots.
    DeviceCheck {
        #[arg(long)]
        serial: String,
        #[arg(long)]
        fresh: bool,
    },
    /// Create an owner-local upload key and store its password in macOS Keychain.
    SigningInit,
    /// Build and verify signed production artifacts without publishing them.
    Distribution {
        #[arg(long)]
        build_number: u32,
        #[arg(long)]
        prepared: bool,
    },
    /// Prepare unsigned production artifacts without a signing identity.
    Prepare {
        #[arg(long)]
        build_number: u32,
    },
    /// Verify and prepare the pinned national archive and the development fixture.
    Bundle {
        #[arg(long)]
        source: Option<PathBuf>,
    },
    /// Run compilation, lint, and the host behavioral tests.
    Check,
    /// Check source refinement, Lean theorems, kernel replay, and a rejected defect.
    Prove,
    /// Run the distribution gate on the specified connected devices.
    ReleaseCheck {
        #[arg(long, required = true)]
        serial: Vec<String>,
    },
    /// Install and open the verification build on one selected device.
    Install {
        #[arg(long)]
        serial: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Declaration {
    release: String,
    manifest_sha256: String,
    snapshot: String,
    contacts: u64,
    bytes: u64,
    sha256: String,
}

fn root() -> Result<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .context("Cannot locate the project root")
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn file_digest(path: &Path) -> Result<String> {
    let mut source = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; IO_BUFFER_BYTES];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn hash_shape(value: &str) -> bool {
    value.len() == SHA256_HEX_CHARACTERS
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn completed(mut command: Command) -> Result<Output> {
    let output = command.output().context("Cannot run the project command")?;
    ensure!(
        output.status.code() != Some(TIMEOUT_EXIT_CODE),
        "Inconclusive: verification reached its process safety limit"
    );
    ensure!(
        output.status.success(),
        "Command failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(output)
}
fn run(mut command: Command) -> Result<()> {
    ensure!(
        command
            .status()
            .context("Cannot start the project command")?
            .success(),
        "Project command failed"
    );
    Ok(())
}
fn gradle(root: &Path, arguments: &[&str]) -> Result<()> {
    let android_sdk = sdk()?;
    let platform =
        fs::read_to_string(android_sdk.join("platforms/android-37.0/source.properties"))?;
    let build_tools = fs::read_to_string(android_sdk.join("build-tools/36.0.0/source.properties"))?;
    ensure!(
        platform.lines().any(|line| line == "Pkg.Revision=2")
            && platform
                .lines()
                .any(|line| line == "AndroidVersion.ApiLevel=37.0")
            && build_tools
                .lines()
                .any(|line| line == "Pkg.Revision=36.0.0"),
        "Install Android SDK platform android-37.0 revision 2 and build-tools 36.0.0"
    );
    let mut command = Command::new("gradle");
    without_credentials(&mut command);
    command
        .current_dir(root.join("android"))
        .args(arguments)
        .arg("--console=plain");
    let output = completed(command)?;
    let log = String::from_utf8(output.stdout)?;
    fs::create_dir_all(root.join("target/android"))?;
    fs::write(root.join("target/android/gradle-check.txt"), &log)?;
    ensure!(
        !log.contains("compiler errors found during analysis"),
        "Detekt could not analyze the complete compilation; inspect target/android/gradle-check.txt"
    );
    println!("Android Gradle checks passed: {}", arguments.join(" "));
    Ok(())
}

fn without_credentials(command: &mut Command) -> &mut Command {
    for name in [
        "PHONEBOOK_KEY_PASSWORD",
        "PHONEBOOK_ANDROID_KEYSTORE",
        "PHONEBOOK_ANDROID_KEY_ALIAS",
        "PHONEBOOK_ANDROID_STORE_PASSWORD",
        "PHONEBOOK_ANDROID_KEY_PASSWORD",
        "DOPPLER_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "CLOUDFLARE_API_TOKEN",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "ACTIONS_ID_TOKEN_REQUEST_URL",
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        "ACTIONS_RUNTIME_TOKEN",
    ] {
        command.env_remove(name);
    }
    command
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}
fn assets(root: &Path, flavor: &str, bytes: &[u8], declaration: &Value) -> Result<()> {
    let directory = root.join(format!("android/app/src/{flavor}/assets"));
    fs::create_dir_all(&directory)?;
    let temporary = directory.join("directory.pending");
    fs::write(&temporary, bytes)?;
    fs::rename(temporary, directory.join("directory.tsv.br"))?;
    write_json(&directory.join("directory.json"), declaration)?;
    let notices = format!(
        "AndroidX, Kotlin, Kotlin libraries, JSpecify, and Guava listenablefuture\nApache License 2.0\n\n{}\nBrotli decoder 0.1.2\n{BROTLI_PROJECT_URL}\n\n{}",
        fs::read_to_string(root.join("LICENSE-APACHE"))?,
        fs::read_to_string(root.join("android/licenses/Brotli.txt"))?
    );
    fs::write(directory.join("OSS-NOTICES.txt"), notices)?;
    Ok(())
}
fn bundle(root: &Path, source: Option<&Path>) -> Result<()> {
    let test_assets = root.join("android/app/build/generated/searchContractAssets");
    fs::create_dir_all(&test_assets)?;
    fs::copy(
        root.join("ios/Tests/PhonebookCoreTests/SearchContract.json"),
        test_assets.join("SearchContract.json"),
    )?;
    let declaration: Declaration =
        serde_json::from_slice(&fs::read(root.join("android/bundled-dataset.json"))?)?;
    ensure!(
        hash_shape(&declaration.snapshot)
            && hash_shape(&declaration.sha256)
            && hash_shape(&declaration.manifest_sha256),
        "Invalid bundled identity"
    );
    ensure!(
        declaration.bytes > 0
            && declaration.bytes <= MAXIMUM_TRANSFER_BYTES
            && declaration.contacts <= MAXIMUM_CONTACTS,
        "Invalid bundled bounds"
    );
    let cache = root.join("target/android/cache");
    fs::create_dir_all(&cache)?;
    let file = source
        .map(Path::to_path_buf)
        .unwrap_or_else(|| cache.join(format!("{}.br", declaration.sha256)));
    if !file.exists() {
        let path = format!(
            "{SERVICE_ORIGIN}/api/datasets/{}/{}/directory.tsv.br",
            declaration.snapshot, declaration.sha256
        );
        let mut command = Command::new("curl");
        command
            .args([
                "--fail",
                "--silent",
                "--show-error",
                "--proto",
                "=https",
                "--max-time",
                "180",
                "--output",
            ])
            .arg(&file)
            .arg(path);
        run(command)?;
    }
    ensure!(
        fs::metadata(&file)?.len() == declaration.bytes
            && file_digest(&file)? == declaration.sha256,
        "Bundled archive identity mismatch"
    );
    let national = fs::read(&file)?;
    let metadata = serde_json::to_value(&declaration)?;
    for flavor in ["production", "verification"] {
        assets(root, flavor, &national, &metadata)?;
    }
    let fixtures: Vec<Value> = serde_json::from_slice(&fs::read(
        root.join("ios/Tests/PhonebookKitTests/DirectoryContract.json"),
    )?)?;
    let listing = fixtures
        .iter()
        .find(|entry| entry["revision"] == "baseline" && entry["path"] == "/api/datasets")
        .context("Missing development listing")?;
    let listing: Value =
        serde_json::from_str(listing["body"].as_str().context("Missing listing body")?)?;
    let archive = listing["files"]
        .as_array()
        .context("Missing development files")?
        .iter()
        .find(|entry| entry["format"] == "public-phonebook-directory/1")
        .context("Missing development archive")?;
    let entry = fixtures
        .iter()
        .find(|entry| entry["revision"] == "baseline" && entry["path"] == archive["url"])
        .context("Missing development archive bytes")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(entry["body"].as_str().context("Missing archive body")?)?;
    ensure!(
        Some(bytes.len() as u64) == archive["bytes"].as_u64()
            && Some(digest(&bytes).as_str()) == archive["sha256"].as_str(),
        "Development archive identity mismatch"
    );
    assets(
        root,
        "development",
        &bytes,
        &json!({"snapshot":listing["snapshot"], "contacts":listing["contacts"], "bytes":archive["bytes"], "sha256":archive["sha256"]}),
    )?;
    println!(
        "Bundled verified national archive: {} contacts; development fixture: {} contacts",
        declaration.contacts, listing["contacts"]
    );
    Ok(())
}

const REFINEMENTS: [(&str, &str); 13] = [
    (
        "android/core/src/main/kotlin/page/dial/core/DirectoryPolicy.kt",
        "funcanAppend(more:Boolean,sameQuery:Boolean):Boolean=more&&sameQuery",
    ),
    (
        "android/core/src/main/kotlin/page/dial/core/DirectoryPolicy.kt",
        "funvalidDepth(depth:Int):Boolean=depth>=0&&depth<DirectoryLimits.MAXIMUM_JSON_DEPTH",
    ),
    (
        "android/core/src/main/kotlin/page/dial/core/DirectoryPolicy.kt",
        "fun<T>restart(more:Boolean,previous:T?,received:T?):Boolean=more&&previous!=received",
    ),
    (
        "android/core/src/main/kotlin/page/dial/core/Directory.kt",
        "funadmit(facts:ValidationFacts):Boolean=facts.length&&facts.digest&&facts.snapshot&&facts.rows&&facts.complete",
    ),
    (
        "android/core/src/main/kotlin/page/dial/core/Directory.kt",
        "funtransfer(metered:Boolean,restricted:Boolean):Boolean=!metered&&!restricted",
    ),
    (
        "android/core/src/main/kotlin/page/dial/core/Directory.kt",
        "fundue(last:Long?,now:Long):Boolean=last==null||(last>=0&&now>=last&&now-last>=UPDATE_INTERVAL_SECONDS)",
    ),
    (
        "android/core/src/main/kotlin/page/dial/core/DirectoryPolicy.kt",
        "funchunk(received:Long,count:Long,expected:Long):Boolean=received>=0&&count>=0&&received<=expected&&count<=expected-received",
    ),
    (
        "android/core/src/main/kotlin/page/dial/core/DirectoryPolicy.kt",
        "funcopy(start:Long,count:Long,base:Long):Boolean=start>=0&&count>=1&&count<=base&&start<=base-count",
    ),
    (
        "android/core/src/main/kotlin/page/dial/core/DirectoryPolicy.kt",
        "fun<T>select(active:T?,candidate:T,phase:GenerationPhase,valid:Boolean,observedCandidate:Boolean):T?=if(!valid)activeelseif(phase==GenerationPhase.Complete)candidateelseif(phase==GenerationPhase.Uncertain&&observedCandidate)candidateelseactive",
    ),
    (
        "android/core/src/main/kotlin/page/dial/core/DirectoryPolicy.kt",
        "funcanActivate(phase:GenerationPhase,valid:Boolean):Boolean=phase==GenerationPhase.Indexed&&valid",
    ),
    (
        "android/core/src/main/kotlin/page/dial/core/DirectoryPolicy.kt",
        "funrank(words:Int,named:Int,placed:Int,rank:Int):Int?=if(named+placed<words)nullelseif(named<words)PLACE_RANKelseif(words==1)rankelse2",
    ),
    (
        "android/core/src/main/kotlin/page/dial/core/DirectoryPolicy.kt",
        "fundisplay(started:Long,now:Long,found:Boolean,held:Boolean):Boolean=started>=0&&now>=started&&now-started<LOOKUP_BUDGET_MILLIS&&found&&held",
    ),
    (
        "android/core/src/main/kotlin/page/dial/core/DirectoryPolicy.kt",
        "funcanDiscard(phase:GenerationPhase):Boolean=phase!=GenerationPhase.Uncertain&&phase!=GenerationPhase.Complete",
    ),
];
const THEOREMS: [&str; 31] = [
    "pageAppendRequiresTheSameQuery",
    "killedMutantsRequireCompletedBehavior",
    "mutationCampaignRequiresEveryExpectedResult",
    "activationRequiresIndexedAndValidatedCandidate",
    "unconfirmedPublicationRetainsTheActiveGeneration",
    "confirmedUncertainPublicationActivates",
    "pageRestartRequiresGenerationChange",
    "acceptedJsonDepthIsBounded",
    "jsonDescentFitsInt32",
    "admissionRequiresEveryCheck",
    "automaticTransfersAvoidRestrictedPaths",
    "answeredChecksWaitADay",
    "dueSubtractionFitsInt64",
    "acceptedChunksStayWithinTheFile",
    "acceptedChunkArithmeticFitsInt64",
    "acceptedCopiesReadOnlyBaseRows",
    "copyArithmeticFitsInt64",
    "unmatchedWordsReject",
    "regionMatchesRankAfterNameMatches",
    "prepublicationImportRetainsTheActiveGeneration",
    "rejectedImportRetainsTheActiveGeneration",
    "completeImportActivatesAsAUnit",
    "uncommittedTraceRetainsTheActiveGeneration",
    "screeningNeverBlocksRejectsSilencesOrSkipsLogs",
    "callerDisplayRequiresARoleAndATimelyMatch",
    "callerClockSubtractionFitsInt64",
    "wordCountArithmeticFitsInt32",
    "permissionResponseOccursOnce",
    "repeatedPermissionResponsesAreIdempotent",
    "uncertainCandidateSurvivesAbort",
    "activeCandidateSurvivesAbort",
];
fn compact(source: &str) -> String {
    source
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .replace(",)", ")")
}
fn reviewed_functions(source: &str) -> Vec<String> {
    let lines: Vec<_> = source.lines().collect();
    lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.trim_start().starts_with("fun "))
        .map(|(index, line)| {
            let indentation = line.len() - line.trim_start().len();
            let end = lines[index + 1..]
                .iter()
                .position(|next| {
                    let next_text = next.trim_start();
                    next.len() - next_text.len() <= indentation
                        && [
                            "}",
                            "fun ",
                            "private ",
                            "internal ",
                            "public ",
                            "protected ",
                            "const ",
                            "val ",
                            "var ",
                            "object ",
                            "class ",
                            "enum ",
                            "data ",
                            "@",
                        ]
                        .iter()
                        .any(|prefix| next_text.starts_with(prefix))
                })
                .map_or(lines.len(), |offset| index + 1 + offset);
            compact(&lines[index..end].join("\n"))
        })
        .collect()
}
fn source_refinement(root: &Path) -> Result<BTreeMap<String, String>> {
    let mut hashes = BTreeMap::new();
    let mutation = "tools/android-check/src/mutation.rs";
    let source = compact(&fs::read_to_string(root.join(mutation))?);
    for expression in [
        "fnbehavioral_kill(compiled:bool,completed:bool,failed:bool,aborted:bool)->bool{compiled&&completed&&failed&&!aborted}",
        "fncomplete_campaign(expected:usize,executed:usize,all_killed:bool)->bool{expected>0&&expected==executed&&all_killed}",
    ] {
        ensure!(
            source.matches(expression).count() == 1,
            "Unreviewed mutation verdict refinement"
        );
    }
    hashes.insert(mutation.into(), file_digest(&root.join(mutation))?);
    for (file, expression) in REFINEMENTS {
        let source = fs::read_to_string(root.join(file))?;
        ensure!(
            !source.contains("/*") && !source.contains("\"\"\""),
            "Modeled policy declarations exclude block comments and multiline literals: {file}"
        );
        ensure!(
            reviewed_functions(&source)
                .iter()
                .filter(|function| *function == expression)
                .count()
                == 1,
            "Unreviewed Kotlin refinement: {file}: {expression}"
        );
        hashes.insert(file.into(), digest(source.as_bytes()));
    }
    for (file, constant) in [
        (
            "android/core/src/main/kotlin/page/dial/core/Directory.kt",
            "constvalUPDATE_INTERVAL_SECONDS=86400L",
        ),
        (
            "android/core/src/main/kotlin/page/dial/core/DirectoryPolicy.kt",
            "constvalPLACE_RANK=3",
        ),
        (
            "android/core/src/main/kotlin/page/dial/core/DirectoryPolicy.kt",
            "constvalLOOKUP_BUDGET_MILLIS=1000L",
        ),
        (
            "android/core/src/main/kotlin/page/dial/core/DirectoryLimits.kt",
            "constvalMAXIMUM_QUERY_WORDS=8",
        ),
        (
            "android/core/src/main/kotlin/page/dial/core/DirectoryLimits.kt",
            "constvalMAXIMUM_JSON_DEPTH=32",
        ),
    ] {
        let source = fs::read_to_string(root.join(file))?;
        ensure!(
            !source.contains("/*") && !source.contains("\"\"\""),
            "Modeled constants exclude block comments and multiline literals: {file}"
        );
        ensure!(
            compact(&source).contains(constant),
            "Unreviewed modeled constant: {constant}"
        );
        hashes.insert(file.into(), digest(source.as_bytes()));
    }
    let screening =
        "android/app/src/main/kotlin/page/dial/publicphonebook/PhonebookScreeningService.kt";
    let source = compact(&fs::read_to_string(root.join(screening))?);
    let expected = "overridefunonScreenCall(callDetails:Call.Details){if(callDetails.callDirection!=Call.Details.DIRECTION_INCOMING)returnvalresponse=CallResponse.Builder().setDisallowCall(false).setRejectCall(false).setSilenceCall(false).setSkipCallLog(false).setSkipNotification(false).build()valsent=AtomicBoolean(false)valallow=Runnable{if(sent.compareAndSet(false,true))respondToCall(callDetails,response)}handler.postDelayed(allow,CallerPolicy.LOOKUP_BUDGET_MILLIS)valstarted=SystemClock.elapsedRealtime()";
    ensure!(
        source.contains(expected),
        "Incoming call permission deadline must precede local lookup and display"
    );
    ensure!(
        source.contains("finally{allow.run()handler.removeCallbacks(allow)}"),
        "Every lookup outcome must allow the call"
    );
    hashes.insert(screening.into(), file_digest(&root.join(screening))?);
    let view_model = "android/app/src/main/kotlin/page/dial/publicphonebook/DirectoryViewModel.kt";
    let source = compact(&fs::read_to_string(root.join(view_model))?);
    for boundary in [
        "valcontinuing=PagePolicy.canAppend(more,state.value.resultQuery==query)",
        "valoffset=if(continuing)previous.contacts.sizeelse0",
        "PagePolicy.restart(continuing,previous.snapshot,result.snapshot)",
        "state.value.copy(results=results,resultQuery=query,searching=false)",
    ] {
        ensure!(
            source.contains(boundary),
            "Pagination must bind results to their query and generation"
        );
    }
    hashes.insert(view_model.into(), file_digest(&root.join(view_model))?);
    let storage = "android/data/src/main/kotlin/page/dial/data/SQLiteDirectory.kt";
    let source = compact(&fs::read_to_string(root.join(storage))?);
    for boundary in [
        "valadmitted=SyncPolicy.admit(facts)",
        "privatefunactivate(staged:StagedGeneration,name:String,admitted:Boolean)=gate.write{requireDirectory(PublicationPolicy.canActivate(staged.phase,admitted))valprevious=activeName()",
        "valselected=PublicationPolicy.select(previous,name,staged.phase,admitted,observed?.current==name)if(selected!=name)throwfailure?:InvalidDirectory(\"Generationactivationisunconfirmed\")",
    ] {
        ensure!(
            source.contains(boundary),
            "Publication refinement must use actual stage and pointer observations"
        );
    }
    hashes.insert(storage.into(), file_digest(&root.join(storage))?);
    Ok(hashes)
}
fn container(root: &Path, output: &Path, image: &str, arguments: &[&str]) -> Command {
    let mut command = Command::new("docker");
    command
        .args([
            "run",
            "--rm",
            "--platform",
            "linux/amd64",
            "--network",
            "none",
            "--memory",
            "2048m",
            "--memory-swap",
            "2048m",
            "--cpus",
            "2",
            "--pids-limit",
            "256",
        ])
        .arg("--mount")
        .arg(format!(
            "type=bind,source={},target=/work,readonly",
            root.display()
        ))
        .arg("--mount")
        .arg(format!(
            "type=bind,source={},target=/proof",
            output.display()
        ))
        .args([
            "--workdir",
            "/work",
            image,
            "timeout",
            "900",
            "env",
            "LEAN_PATH=/proof",
        ])
        .args(arguments);
    command
}
fn prove(root: &Path) -> Result<()> {
    let sources = source_refinement_with_model(root)?;
    let source = fs::read_to_string(root.join("verification/android/DirectoryPolicy.lean"))?;
    ensure!(
        !["sorry", "axiom ", "unsafe ", "native_decide"]
            .iter()
            .any(|word| source.contains(word)),
        "Unsupported proof escape"
    );
    let mut build = Command::new("docker");
    build.current_dir(root).args([
        "build",
        "--platform",
        "linux/amd64",
        "--tag",
        "public-phonebook-android-proof:local",
        "--file",
        "verification/ios/Dockerfile",
        ".",
    ]);
    run(build)?;
    let mut inspect = Command::new("docker");
    inspect.args([
        "image",
        "inspect",
        "public-phonebook-android-proof:local",
        "--format",
        "{{.Id}}",
    ]);
    let image = String::from_utf8(completed(inspect)?.stdout)?
        .trim()
        .to_owned();
    ensure!(
        image.strip_prefix("sha256:").is_some_and(hash_shape),
        "Proof image is not immutable"
    );
    let output = root.join("target/android/proof");
    fs::create_dir_all(&output)?;
    let compiled = completed(container(
        root,
        &output,
        &image,
        &[
            "lean",
            "-o",
            "/proof/DirectoryPolicy.olean",
            "verification/android/DirectoryPolicy.lean",
        ],
    ))?;
    let log = String::from_utf8(compiled.stdout)?;
    ensure!(
        !log.contains("sorryAx") && !log.contains("warning:"),
        "Incomplete proof or unresolved Lean diagnostic"
    );
    for theorem in THEOREMS {
        ensure!(
            log.contains(&format!("'Phonebook.Android.{theorem}'")),
            "Missing theorem: {theorem}"
        );
    }
    fs::write(output.join("axioms.txt"), &log)?;
    run(container(
        root,
        &output,
        &image,
        &["leanchecker", "--fresh", "DirectoryPolicy"],
    ))?;
    let defective = source.replacen(
        "length && digest && snapshot && rows && complete",
        "length || digest && snapshot && rows && complete",
        1,
    );
    ensure!(defective != source, "No planted proof defect");
    fs::write(output.join("RejectedAdmission.lean"), defective)?;
    let rejected = container(
        root,
        &output,
        &image,
        &["lean", "/proof/RejectedAdmission.lean"],
    )
    .output()?;
    let rejected_log = String::from_utf8(rejected.stdout)?;
    ensure!(
        !rejected.status.success()
            && rejected_log.contains("unsolved goals")
            && rejected_log.contains("admissionRequiresEveryCheck"),
        "The negative control did not reject the intended false theorem"
    );
    fs::write(output.join("rejected-admission.txt"), rejected_log)?;
    ensure!(
        sources == source_refinement_with_model(root)?,
        "Proof sources changed during verification"
    );
    write_json(
        &output.join("receipt.json"),
        &json!({"sources":sources,"image":image,"lean":"4.34.1","theorems":THEOREMS,"kernelReplay":"passed","negativeControl":"rejected"}),
    )?;
    println!(
        "Android proof: {} theorem checks, fresh kernel replay, and rejected admission defect passed",
        THEOREMS.len()
    );
    Ok(())
}
fn source_refinement_with_model(root: &Path) -> Result<BTreeMap<String, String>> {
    let mut sources = source_refinement(root)?;
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
        .args(BUILD_INPUT_PATHS)
        .args([
            "verification/android",
            ".gitignore",
            "justfile",
            ".github/workflows/assurance.yml",
            "verification/ios/Dockerfile",
        ]);
    let files = String::from_utf8(completed(listing)?.stdout)?;
    for required in [
        "verification/android/DirectoryPolicy.lean",
        "tools/android-check/src/main.rs",
        "android/bundled-dataset.json",
    ] {
        ensure!(
            files.split('\0').any(|file| file == required),
            "Missing proof input inventory: {required}"
        );
    }
    for file in files
        .split('\0')
        .filter(|file| !file.is_empty() && !file.starts_with("android/store/"))
    {
        sources.insert(file.into(), file_digest(&root.join(file))?);
    }
    Ok(sources)
}

fn require_current_proof(root: &Path) -> Result<()> {
    let receipt: Value = serde_json::from_slice(
        &fs::read(root.join("target/android/proof/receipt.json"))
            .context("Run android-prove for this candidate")?,
    )?;
    ensure!(
        receipt["sources"] == serde_json::to_value(source_refinement_with_model(root)?)?
            && receipt["theorems"] == serde_json::to_value(THEOREMS)?
            && receipt["kernelReplay"] == "passed"
            && receipt["negativeControl"] == "rejected",
        "Android proof receipt is stale or incomplete; run android-prove"
    );
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseCheckReceipt {
    result: String,
    apis: std::collections::BTreeSet<u32>,
    formal_theorems: usize,
    proof_sha256: String,
    mutation_sha256: String,
    apk_sha256: String,
    test_apk_sha256: String,
    caller_identification: String,
}

fn release_receipt(root: &Path) -> Result<ReleaseCheckReceipt> {
    require_current_proof(root)?;
    mutation::require_current(root)?;
    Ok(ReleaseCheckReceipt {
        result: "passed".into(),
        apis: [MINIMUM_ANDROID_API, COMPILE_ANDROID_API].into(),
        formal_theorems: THEOREMS.len(),
        proof_sha256: file_digest(&root.join("target/android/proof/receipt.json"))?,
        mutation_sha256: file_digest(&root.join("target/android/mutation/receipt.json"))?,
        apk_sha256: file_digest(&root.join("android/app/build/outputs/apk/verification/debug/app-verification-debug.apk"))?,
        test_apk_sha256: file_digest(&root.join("android/app/build/outputs/apk/androidTest/verification/debug/app-verification-debug-androidTest.apk"))?,
        caller_identification: "unverified".into(),
    })
}

fn require_current_release(root: &Path) -> Result<()> {
    let receipt: ReleaseCheckReceipt = serde_json::from_slice(
        &fs::read(root.join("target/android/release-check.json"))
            .context("Run android-release-check before creating distribution artifacts")?,
    )?;
    ensure!(
        serde_json::to_value(&receipt)? == serde_json::to_value(release_receipt(root)?)?,
        "Android distribution checks are stale or incomplete; run android-release-check"
    );
    Ok(())
}
fn sdk() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("ANDROID_HOME") {
        return Ok(path.into());
    }
    if cfg!(target_os = "macos") {
        return Ok(
            PathBuf::from(std::env::var_os("HOME").context("Missing user directory")?)
                .join("Library/Android/sdk"),
        );
    }
    bail!("Set ANDROID_HOME to the Android SDK")
}
fn install(root: &Path, serial: &str) -> Result<()> {
    ensure!(
        !serial.is_empty() && !serial.starts_with('-'),
        "Select one connected device"
    );
    let adb = sdk()?.join("platform-tools/adb");
    let mut command = Command::new(&adb);
    command.args(["-s", serial, "install", "-r"]).arg(
        root.join("android/app/build/outputs/apk/verification/debug/app-verification-debug.apk"),
    );
    run(command)?;
    let mut command = Command::new(adb);
    command.args([
        "-s",
        serial,
        "shell",
        "am",
        "start",
        "-n",
        "page.dial.publicphonebook.verification/page.dial.publicphonebook.MainActivity",
    ]);
    run(command)
}
fn main() -> Result<()> {
    let arguments = Arguments::parse();
    let root = root()?;
    match arguments.action {
        Action::Mutate { plan, select } => mutation::run(&root, plan, &select),
        Action::StoreAssets { check } => distribution::store_assets(&root, check),
        Action::DeviceCheck { serial, fresh } => {
            gradle(
                &root,
                &[
                    ":app:assembleVerificationDebug",
                    ":app:assembleVerificationDebugAndroidTest",
                ],
            )?;
            device::check(&root, &serial, fresh).map(|_| ())
        }
        Action::SigningInit => distribution::initialize(),
        Action::Distribution {
            build_number,
            prepared,
        } => distribution::build(&root, build_number, prepared),
        Action::Prepare { build_number } => distribution::prepare(&root, build_number),
        Action::Bundle { source } => bundle(&root, source.as_deref()),
        Action::Check => {
            source_refinement(&root)?;
            mutation::validate(&root)?;
            gradle(
                &root,
                &[
                    "ktfmtCheck",
                    "detekt",
                    ":core:detektMain",
                    ":data:detektDebug",
                    ":app:detektVerificationDebug",
                    ":core:test",
                    ":data:testDebugUnitTest",
                    ":app:testVerificationDebugUnitTest",
                    ":app:lintVerificationDebug",
                    ":app:assembleVerificationDebug",
                ],
            )
        }
        Action::Prove => prove(&root),
        Action::ReleaseCheck { serial } => {
            source_refinement(&root)?;
            distribution::store_assets(&root, true)?;
            if mutation::require_current(&root).is_err() {
                mutation::run(&root, false, &[])?;
            }
            prove(&root)?;
            gradle(
                &root,
                &[
                    "ktfmtCheck",
                    "detekt",
                    ":core:detektMain",
                    ":data:detektDebug",
                    ":app:detektVerificationDebug",
                    ":core:test",
                    ":data:testDebugUnitTest",
                    ":app:testVerificationDebugUnitTest",
                    ":app:lintProductionRelease",
                    ":app:assembleVerificationDebug",
                    ":app:assembleVerificationDebugAndroidTest",
                ],
            )?;
            let mut versions = std::collections::BTreeSet::new();
            for serial in serial {
                versions.insert(device::check(
                    &root,
                    &serial,
                    serial.starts_with("emulator-"),
                )?);
            }
            ensure!(
                versions.contains(&MINIMUM_ANDROID_API) && versions.contains(&COMPILE_ANDROID_API),
                "Distribution evidence requires both Android API 29 and 37"
            );
            write_json(
                &root.join("target/android/release-check.json"),
                &release_receipt(&root)?,
            )?;
            println!(
                "Android distribution checks passed: {} theorems and API 29/37 emulator tests; physical caller identification remains unverified",
                THEOREMS.len()
            );
            Ok(())
        }
        Action::Install { serial } => {
            gradle(&root, &[":app:assembleVerificationDebug"])?;
            install(&root, &serial)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gradle_never_inherits_delivery_capabilities() {
        let mut command = Command::new("gradle");
        for name in [
            "PHONEBOOK_KEY_PASSWORD",
            "PHONEBOOK_ANDROID_KEYSTORE",
            "PHONEBOOK_ANDROID_KEY_ALIAS",
            "PHONEBOOK_ANDROID_STORE_PASSWORD",
            "PHONEBOOK_ANDROID_KEY_PASSWORD",
            "DOPPLER_TOKEN",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "CLOUDFLARE_API_TOKEN",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
            "ACTIONS_ID_TOKEN_REQUEST_URL",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
            "ACTIONS_RUNTIME_TOKEN",
        ] {
            command.env(name, "fixture credential");
        }
        command.env("ANDROID_HOME", "/fixture/sdk");
        without_credentials(&mut command);
        assert_eq!(
            command
                .get_envs()
                .filter(|(name, value)| *name != "ANDROID_HOME" && value.is_none())
                .count(),
            14
        );
        assert!(
            command
                .get_envs()
                .any(|(name, value)| name == "ANDROID_HOME" && value.is_some())
        );
    }
    #[test]
    fn identities_are_exact_and_path_safe() {
        assert!(hash_shape(&"a".repeat(64)));
        for invalid in [
            "../active".to_owned(),
            "a".repeat(63),
            "A".repeat(64),
            "g".repeat(64),
        ] {
            assert!(!hash_shape(&invalid));
        }
    }
    #[test]
    fn refinement_refuses_a_changed_validation_branch() -> Result<()> {
        let reviewed = REFINEMENTS
            .iter()
            .find(|(_, expression)| expression.starts_with("funadmit("))
            .context("Missing admission refinement")?
            .1;
        let broken = reviewed.replacen("&&", "||", 1);
        assert!(!compact(&broken).contains(reviewed));
        let source = "object Policy {\n    fun admit(facts: ValidationFacts): Boolean =\n        facts.length && facts.digest && facts.snapshot && facts.rows && facts.complete\n}\n";
        assert_eq!(reviewed_functions(source), [reviewed]);
        let multiline = source.replace(
            "fun admit(facts: ValidationFacts): Boolean",
            "fun admit(\n        facts: ValidationFacts,\n    ): Boolean",
        );
        assert_eq!(reviewed_functions(&multiline), [reviewed]);
        assert_ne!(
            reviewed_functions(&source.replace("facts.complete", "facts.complete && false")),
            [reviewed]
        );
        assert_ne!(
            reviewed_functions(&source.replace("facts.complete", "facts.complete\n    && false")),
            [reviewed]
        );
        Ok(())
    }
}
