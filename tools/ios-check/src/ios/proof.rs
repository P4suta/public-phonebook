use super::{SHA256_HEX_LENGTH, logged, require_current_sources, source_hashes, source_records};
use crate::locations::{LEAN, LEAN_CHECKER};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fmt::Write as _, fs, path::Path, process::Command};

const THEOREMS: [&str; 21] = [
    "activeAbsorbsEveryEvent",
    "activeSurvivesEveryFiniteTrace",
    "uncertainAbortRetainsData",
    "activeNeverPermitsDiscard",
    "beginningActivationProtectsData",
    "confirmedActivationBecomesActive",
    "confirmedInactiveCanAbort",
    "abortDiscardsOnlyKnownInactive",
    "admittedBytesStayWithinLimit",
    "admittedAdditionCannotOverflowInt64",
    "subtractionCannotOverflowInt64",
    "deltaAppliesOnlyWhenEveryCheckPasses",
    "mismatchedBaseRejectsFirst",
    "malformedDeltaRejectsBeforeCounts",
    "rowCountPrecedesLengthAndDigest",
    "lengthPrecedesDigest",
    "digestDecidesMatchingCounts",
    "copyAdmissionMatchesTheProviderGuard",
    "admittedCopyReadsOnlyBaseRows",
    "copyGuardSubtractionCannotOverflowInt64",
    "admittedCopyEndCannotOverflowInt64",
];
const RECEIVE_SOURCE: &str =
    include_str!("../../../../ios/Sources/PhonebookCore/ReceiveBudget.swift");
const DELTA_SOURCE: &str =
    include_str!("../../../../ios/Sources/PhonebookCore/DeltaAdmission.swift");
/// The Swift delta decision that `verification/ios/DeltaAdmission.lean` models, without whitespace.
const DELTA_REFINEMENT: &str = "publicenumDeltaAdmission:String,CaseIterable,Sendable{caseapply,baseMismatch,malformed,countMismatch,lengthMismatch,digestMismatchpublicstaticfuncdecide(baseMatches:Bool,wellFormed:Bool,rows:Int,expectedRows:Int,bytes:Int,expectedBytes:Int,digestMatches:Bool)->Self{if!baseMatches{return.baseMismatch}if!wellFormed{return.malformed}ifrows!=expectedRows{return.countMismatch}ifbytes!=expectedBytes{return.lengthMismatch}if!digestMatches{return.digestMismatch}return.apply}publicstaticfuncadmitsCopy(start:Int,count:Int,baseRows:Int)->Bool{start>=0&&count>=1&&count<=baseRows&&start<=baseRows-count}}";
const PROOF_MODULES: [&str; 3] = ["Publication", "ReceiveBudget", "DeltaAdmission"];
/// Each false claim must fail at its proof on line 2, which shows that the kernel checks that model.
const FALSE_CLAIMS: [(&str, &str, &str); 2] = [
    (
        "FalseClaim",
        "import PublicationModel\nexample : Phonebook.step .active .abort = .discarded := by rfl\n",
        "false active-deletion claim",
    ),
    (
        "FalseDeltaClaim",
        "import DeltaAdmission\nexample : Phonebook.decideDelta true true 1 1 1 1 false = .apply := by rfl\n",
        "false digest-mismatch admission",
    ),
];
const IDENTIFIER_LIMIT: usize = 32;
const PUBLICATION_STATES: usize = 5;
const PUBLICATION_EVENTS: usize = 5;
const IMAGE_DIGEST_PREFIX: &str = "sha256:";

fn identifier(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= IDENTIFIER_LIMIT
        && name.bytes().all(|byte| byte.is_ascii_alphabetic())
}

fn model(contract: &Value) -> Result<String> {
    let states = contract["states"]
        .as_object()
        .context("Missing publication states")?;
    let events = contract["events"]
        .as_array()
        .context("Missing publication events")?;
    let events = events
        .iter()
        .map(|value| value.as_str().context("Invalid event"))
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        states.len() == PUBLICATION_STATES && events.len() == PUBLICATION_EVENTS,
        "Unexpected contract inventory"
    );
    ensure!(
        states.keys().all(|name| identifier(name)) && events.iter().all(|name| identifier(name)),
        "Invalid Lean identifier"
    );
    ensure!(
        events.iter().collect::<BTreeSet<_>>().len() == events.len(),
        "Duplicate contract event"
    );
    let mut output = String::from("namespace Phonebook\ninductive Phase where\n");
    for name in states.keys() {
        writeln!(output, "  | {name}")?;
    }
    output.push_str("deriving DecidableEq\ninductive Event where\n");
    for event in &events {
        writeln!(output, "  | {event}")?;
    }
    output.push_str("deriving DecidableEq\ndef step : Phase → Event → Phase\n");
    for (state, spec) in states {
        let transitions = spec["transitions"]
            .as_object()
            .context("Missing transitions")?;
        ensure!(
            transitions
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>()
                == events.iter().copied().collect(),
            "Incomplete transition domain"
        );
        for event in &events {
            let target = transitions[*event]
                .as_str()
                .context("Invalid transition target")?;
            ensure!(states.contains_key(target), "Unknown transition target");
            writeln!(output, "  | .{state}, .{event} => .{target}")?;
        }
    }
    output.push_str("def mayDiscard : Phase → Bool\n");
    for (state, spec) in states {
        let discard = spec["canDiscard"]
            .as_bool()
            .context("Invalid discard capability")?;
        writeln!(output, "  | .{state} => {discard}")?;
    }
    output.push_str("end Phonebook\n");
    Ok(output)
}

fn whitespace_free(source: &str) -> String {
    source.split_whitespace().collect()
}

fn axioms_checked(log: &str) -> bool {
    let lines = log
        .lines()
        .filter(|line| line.contains("axioms"))
        .collect::<Vec<_>>();
    lines.iter().all(|line| {
        if line.contains("does not depend on any axioms") {
            return true;
        }
        line.split_once("depends on axioms: [")
            .is_some_and(|(_, axioms)| {
                axioms.strip_suffix(']').is_some_and(|axioms| {
                    axioms.split(',').all(|axiom| {
                        matches!(axiom.trim(), "propext" | "Classical.choice" | "Quot.sound")
                    })
                })
            })
    }) && THEOREMS.iter().all(|name| {
        lines
            .iter()
            .any(|line| line.contains(&format!("Phonebook.{name}'")))
    })
}

fn lean(root: &Path, image: &str, directory: &Path, module: &str) -> Command {
    let mut command = super::super::bounded_command(root, image);
    command
        .arg("env")
        .arg(format!("LEAN_PATH={}", directory.display()))
        .args([
            LEAN,
            "-DwarningAsError=true",
            "-DmaxHeartbeats=1000000",
            "-j2",
            "-R",
        ])
        .arg(directory)
        .arg("-o")
        .arg(directory.join(format!("{module}.olean")))
        .arg(directory.join(format!("{module}.lean")));
    command
}

pub fn run(root: &Path) -> Result<()> {
    fs::create_dir_all(root.join("target/ios"))?;
    let directory = tempfile::Builder::new()
        .prefix("proof-")
        .tempdir_in(root.join("target/ios"))?
        .keep();
    let relative = directory.strip_prefix(root)?;
    let receipt = root.join("target/ios/proof-receipt.json");
    if receipt.exists() {
        fs::remove_file(&receipt)?;
    }
    let sources = source_hashes(root)?;
    let receive = fs::read_to_string(root.join("ios/Sources/PhonebookCore/ReceiveBudget.swift"))?;
    let normalize = whitespace_free;
    ensure!(
        normalize(&receive) == normalize(RECEIVE_SOURCE),
        "Receive model refinement changed; reassess its signed arithmetic semantics"
    );
    ensure!(
        normalize(&receive)
            == "publicenumReceiveBudget{publicstaticfuncadmits(used:Int,incoming:Int,limit:Int)->Bool{used>=0&&incoming>=0&&limit>=used&&incoming<=limit-used}}",
        "The arithmetic proof covers a different implementation"
    );
    let delta = fs::read_to_string(root.join("ios/Sources/PhonebookCore/DeltaAdmission.swift"))?;
    ensure!(
        normalize(&delta) == normalize(DELTA_SOURCE) && normalize(&delta) == DELTA_REFINEMENT,
        "The delta admission proof covers a different implementation"
    );
    let contract: Value = serde_json::from_slice(&fs::read(
        root.join("ios/Tests/PhonebookCoreTests/PublicationContract.json"),
    )?)?;
    fs::write(directory.join("PublicationModel.lean"), model(&contract)?)?;
    for module in PROOF_MODULES {
        let contents = fs::read_to_string(root.join(format!("verification/ios/{module}.lean")))?;
        ensure!(
            !contents
                .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
                .any(|word| matches!(
                    word,
                    "sorry" | "admit" | "axiom" | "unsafe" | "native_decide"
                )),
            "Forbidden proof escape"
        );
        fs::write(directory.join(format!("{module}.lean")), contents)?;
    }
    logged(
        root,
        "lean-image",
        Command::new("docker")
            .current_dir(root)
            .args([
                "build",
                "--quiet",
                "--platform",
                "linux/amd64",
                "--file",
                "verification/ios/Dockerfile",
                "--iidfile",
            ])
            .arg(directory.join("image.id"))
            .arg("verification/ios"),
    )?;
    let image = fs::read_to_string(directory.join("image.id"))?
        .trim()
        .to_owned();
    ensure!(
        image.starts_with(IMAGE_DIGEST_PREFIX)
            && image.len() == IMAGE_DIGEST_PREFIX.len() + SHA256_HEX_LENGTH
            && image[IMAGE_DIGEST_PREFIX.len()..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()),
        "Invalid proof image identity"
    );
    let version = logged(
        root,
        "lean-version",
        super::super::bounded_command(root, &image).args([LEAN, "--version"]),
    )?;
    ensure!(
        String::from_utf8_lossy(&version.stdout).contains("version 4.34.1,"),
        "Unexpected Lean version"
    );
    let mut proofs = String::new();
    for module in std::iter::once("PublicationModel").chain(PROOF_MODULES) {
        let result = logged(
            root,
            &format!("lean-{module}"),
            &mut lean(root, &image, relative, module),
        )?;
        proofs.push_str(&String::from_utf8_lossy(&result.stdout));
        logged(
            root,
            &format!("lean-replay-{module}"),
            super::super::bounded_command(root, &image)
                .arg("env")
                .arg(format!("LEAN_PATH={}", relative.display()))
                .args([LEAN_CHECKER, "--fresh", module]),
        )?;
    }
    ensure!(
        axioms_checked(&proofs),
        "The expected theorem inventory or axiom review is incomplete"
    );
    for (module, source, claim) in FALSE_CLAIMS {
        fs::write(directory.join(format!("{module}.lean")), source)?;
        let negative = lean(root, &image, relative, module).output()?;
        let negative_log = format!(
            "{}{}",
            String::from_utf8_lossy(&negative.stdout),
            String::from_utf8_lossy(&negative.stderr)
        );
        fs::write(
            root.join(format!("target/ios/lean-negative-{module}.log")),
            &negative_log,
        )?;
        ensure!(
            !negative.status.success()
                && negative_log.contains(&format!("{module}.lean:2:"))
                && negative_log.contains("rfl")
                && negative_log.contains("error:"),
            "The {claim} did not fail at its proof"
        );
    }
    require_current_sources(root, &sources)?;
    fs::write(
        receipt,
        serde_json::to_vec_pretty(
            &json!({"result":"passed", "lean":"4.34.1", "image":image, "theorems":THEOREMS, "proof_bundle":relative, "kernel_replay":"fresh for all four modules", "negative_controls":FALSE_CLAIMS.map(|(_, _, claim)| format!("{claim} rejected")), "refinement":"native exhaustive 25-transition check required by ios-check; exact guarded Int64 arithmetic expression; exact delta admission and copy guard source", "source_sha256":source_records(&sources)}),
        )?,
    )?;
    println!(
        "PASS: {} Lean theorems, fresh kernel replay, {} false-claim rejections, source-bound receipt",
        THEOREMS.len(),
        FALSE_CLAIMS.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_or_injected_models_are_rejected() -> Result<()> {
        let valid: Value = serde_json::from_str(include_str!(
            "../../../../ios/Tests/PhonebookCoreTests/PublicationContract.json"
        ))?;
        assert!(model(&valid)?.contains(".active, .abort => .active"));
        let mut invalid = valid.clone();
        invalid["states"]["active"]["transitions"]
            .as_object_mut()
            .context("Test state")?
            .remove("abort");
        assert!(model(&invalid).is_err());
        invalid = valid;
        invalid["events"][0] = json!("abort\naxiom forged : False");
        assert!(model(&invalid).is_err());
        assert!(!axioms_checked(""));
        assert!(!axioms_checked(
            "'Phonebook.activeNeverPermitsDiscard' depends on axioms: [forged]"
        ));
        Ok(())
    }

    #[test]
    fn the_delta_proof_names_the_compiled_swift_decision() {
        assert_eq!(whitespace_free(DELTA_SOURCE), DELTA_REFINEMENT);
        assert_ne!(
            whitespace_free(&DELTA_SOURCE.replace("count >= 1", "count >= 0")),
            DELTA_REFINEMENT
        );
    }
}
