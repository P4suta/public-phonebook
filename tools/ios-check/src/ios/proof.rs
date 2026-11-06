use super::{
    SHA256_HEX_LENGTH, logged_work, require_current_sources, source_hashes, source_records,
};
use crate::locations::{LEAN, LEAN_CHECKER};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fmt::Write as _, fs, path::Path, process::Command};

const THEOREMS: [&str; 72] = [
    "resultPageBounds",
    "resultPageAdvances",
    "resultPageArithmeticFitsInt64",
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
    "countdownNeverRises",
    "countdownNeverRisesAlongAnyTrace",
    "lineChangesAtMostOncePerSecond",
    "changeTimeMovesOnlyWithTheLine",
    "stepKeepsNumbersAboveZero",
    "zeroNeverShowsBeforeCompletion",
    "almostDoneStaysUntilTheEnd",
    "waitingNeverShowsANewEstimate",
    "waitingShowsTheWeakSignal",
    "doneOnlyAfterCompletion",
    "stepsStayForTheirHold",
    "aFastRunGoesStraightToDone",
    "estimateProductsFitInt64",
    "extraGoesFirstExactlyBelow",
    "extraReplacesExactlyTheSameNumber",
    "nationalPassesExactlyBelowTheExtra",
    "withoutAnExtraTheNationalEntriesPassUnchanged",
    "mergedEntriesComeFromTheExtraOrTheNationalFile",
    "theExtraEntryIsAlwaysMerged",
    "otherNumbersKeepTheirNationalEntries",
    "mergedCallersStayAscending",
    "theExtraLabelWinsItsNumber",
    "removeExactlyBelow",
    "addExactlyAbove",
    "keepExactlyTheSameEntry",
    "replaceExactlyAnotherLabel",
    "removedNumbersComeFromTheHeldEntries",
    "addedEntriesComeFromTheWantedEntries",
    "removalsAscend",
    "removalsNameEachNumberOnce",
    "additionsAscend",
    "theChangesTurnTheHeldEntriesIntoTheWantedOnes",
    "everyAddedNumberIsFreeOrRemoved",
    "changesSitWhereTheListsDiffer",
    "equalListsNeedNoChange",
    "answeredReadsStayADayApart",
    "noAutomaticTransferOnACostlyPath",
    "automaticTransferStartsOnAnInexpensivePath",
    "personTransfersUseEveryPath",
    "unchangedListingsStartNothing",
    "incrementalCallerWorkIsBounded",
    "invalidCallerCountsUseFull",
    "callerLoadSubtractionFitsInt64",
    "noCallerChangesAreIncremental",
    "finishedDecodeOnlyAfterEnd",
    "unfinishedDecodeMakesProgress",
    "stalledDecodeAtEOFIsTruncated",
    "stalledDecodeBeforeEOFIsCorrupt",
];
const UPDATE_SOURCE: &str = include_str!("../../../../ios/Sources/PhonebookCore/UpdateCheck.swift");
const RESULT_PAGE_SOURCE: &str =
    include_str!("../../../../ios/Sources/PhonebookCore/ResultPage.swift");
const RESULT_PAGE_REFINEMENT: &str = "publicenumResultPage{publicstaticletsize=20publicstaticfuncend(shown:Int,total:Int)->Int{guardshown>=0,total>=shownelse{return0}returnshown+min(size,total-shown)}}";
/// The SHA-256 of the whitespace-free Swift decision that `verification/ios/UpdateCheck.lean` models function for function.
/// Recheck the Lean model against the Swift file before changing this digest.
const UPDATE_REFINEMENT_SHA256: &str =
    "a0458362c81f812504a67c25c7ce237396afd66abd1240f4b840f722388f2f35";
const UPDATE_CONTRACT: &str = "ios/Tests/PhonebookCoreTests/UpdateContract.json";
const UPDATE_TRACES: &str = "UpdateTraces";
const UPDATE_TRACE_COUNT: usize = 10;
const UPDATE_TRACE_STEPS: usize = 12;
const LISTING_REPLIES: [&str; 5] = ["failed", "notModified", "saved", "delta", "archive"];
const UPDATE_TRANSFERS: [&str; 2] = ["delta", "archive"];
const WAIT_SOURCE: &str = include_str!("../../../../ios/Sources/PhonebookCore/WaitDisplay.swift");
/// The SHA-256 of the whitespace-free Swift policy that `verification/ios/WaitDisplay.lean` models function for function.
/// Recheck the Lean model against the Swift file before changing this digest.
const WAIT_REFINEMENT_SHA256: &str =
    "a816537f6e3c903a27c62633a24b1476d0a82a79e95a327a70eb0d7ebe1c8772";
const WAIT_MODEL: &str = include_str!("../../../../verification/ios/WaitDisplay.lean");
const WAIT_CONTRACT: &str = "ios/Tests/PhonebookCoreTests/WaitContract.json";
const WAIT_TRACES: &str = "WaitTraces";
const WAIT_TRACE_COUNT: usize = 11;
const WAIT_TRACE_STEPS: usize = 15;
const WAIT_LINES: [&str; 5] = [
    "measuring",
    "countdown",
    "longer",
    "almostDone",
    "weakSignal",
];
/// Each planted defect changes one line of the wait model and must fail inside its named theorem with an arithmetic refutation.
const PLANTED_DEFECTS: [(&str, &str, &str, &str); 3] = [
    (
        "WaitRisingCountdown",
        "let next := min s.seconds (ceilSeconds (deadline - now))",
        "let next := ceilSeconds (deadline - now)",
        "choose_seconds_le",
    ),
    (
        "WaitHurriedLine",
        "def lineHoldMs : Int := 1000",
        "def lineHoldMs : Int := 999",
        "lineChangesAtMostOncePerSecond",
    ),
    (
        "WaitZeroCountdown",
        "def almostSeconds : Int := 3",
        "def almostSeconds : Int := -1",
        "choose_shows",
    ),
];
const ARITHMETIC_REFUTATION: &str = "omega could not prove the goal";
const RECEIVE_SOURCE: &str =
    include_str!("../../../../ios/Sources/PhonebookCore/ReceiveBudget.swift");
const DELTA_SOURCE: &str =
    include_str!("../../../../ios/Sources/PhonebookCore/DeltaAdmission.swift");
/// The Swift delta decision that `verification/ios/DeltaAdmission.lean` models, without whitespace.
const DELTA_REFINEMENT: &str = "publicenumDeltaAdmission:String,CaseIterable,Sendable{caseapply,baseMismatch,malformed,countMismatch,lengthMismatch,digestMismatchpublicstaticfuncdecide(baseMatches:Bool,wellFormed:Bool,rows:Int,expectedRows:Int,bytes:Int,expectedBytes:Int,digestMatches:Bool)->Self{if!baseMatches{return.baseMismatch}if!wellFormed{return.malformed}ifrows!=expectedRows{return.countMismatch}ifbytes!=expectedBytes{return.lengthMismatch}if!digestMatches{return.digestMismatch}return.apply}publicstaticfuncadmitsCopy(start:Int,count:Int,baseRows:Int)->Bool{start>=0&&count>=1&&count<=baseRows&&start<=baseRows-count}}";
const CALLER_MERGE_SOURCE: &str =
    include_str!("../../../../ios/Sources/PhonebookCore/CallerMerge.swift");
/// The Swift merge decision that `verification/ios/CallerMerge.lean` models, without whitespace.
const CALLER_MERGE_REFINEMENT: &str = "publicenumCallerMerge:String,CaseIterable,Sendable{casenational,extraFirst,extraReplacespublicstaticfuncdecide(extra:Int64,national:Int64)->Self{ifextra<national{return.extraFirst}ifextra==national{return.extraReplaces}return.national}}";
const CALLER_DELTA_SOURCE: &str =
    include_str!("../../../../ios/Sources/PhonebookCore/CallerDelta.swift");
/// The Swift change decision that `verification/ios/CallerDelta.lean` models, without whitespace.
/// Swift compares the labels' UTF-8 bytes, which Lean's string equality matches because UTF-8 encodes each string one way.
const CALLER_DELTA_REFINEMENT: &str = "publicenumCallerChange:String,CaseIterable,Sendable{caseremove,add,keep,replacepublicstaticfuncdecide(held:Int64,heldLabel:String,wanted:Int64,wantedLabel:String)->Self{ifheld<wanted{return.remove}ifwanted<held{return.add}ifheldLabel.utf8.elementsEqual(wantedLabel.utf8){return.keep}return.replace}}";
const CALLER_LOAD_SOURCE: &str =
    include_str!("../../../../ios/Sources/PhonebookCore/CallerLoadPlan.swift");
const CALLER_LOAD_REFINEMENT: &str = "publicenumCallerLoadPlan:String,CaseIterable,Sendable{caseincremental,fullpublicstaticfuncdecide(removals:Int,additions:Int,limit:Int)->Self{guardremovals>=0,additions>=0,limit>=0,removals<=limitelse{return.full}returnadditions<=limit-removals?.incremental:.full}}";
const DECODE_SOURCE: &str =
    include_str!("../../../../ios/Sources/PhonebookCore/DecodeProgress.swift");
const DECODE_REFINEMENT: &str = "publicenumDecodeProgress:Equatable,CaseIterable,Sendable{casemore,finished,corrupt,truncatedpublicstaticfuncdecide(consumed:Int,produced:Int,ended:Bool,exhausted:Bool)->Self{ifended{return.finished}ifconsumed>0||produced>0{return.more}returnexhausted?.truncated:.corrupt}}";
/// Each planted defect changes one place in its model and must fail inside every theorem it names and nowhere else.
const DELTA_DEFECTS: [(&str, &str, &str, &str, &[&str]); 8] = [
    (
        "DecodeAcceptsNoProgress",
        "DecodeProgress",
        "else if 0 < consumed ∨ 0 < produced then .more",
        "else if 0 ≤ consumed ∨ 0 < produced then .more",
        &[
            "unfinishedDecodeMakesProgress",
            "stalledDecodeAtEOFIsTruncated",
            "stalledDecodeBeforeEOFIsCorrupt",
        ],
    ),
    (
        "CallerDeltaKeepsAChangedLabel",
        "CallerDelta",
        "  else .replace",
        "  else .keep",
        &["keepExactlyTheSameEntry", "replaceExactlyAnotherLabel"],
    ),
    (
        "UpdateHurriedCheck",
        "UpdateCheck",
        "def updateIntervalSeconds : Int := 86400",
        "def updateIntervalSeconds : Int := 86399",
        &["answeredReadsStayADayApart"],
    ),
    (
        "UpdateConstrainedTransfer",
        "UpdateCheck",
        "def UpdatePath.inexpensive (p : UpdatePath) : Bool := !p.expensive && !p.constrained",
        "def UpdatePath.inexpensive (p : UpdatePath) : Bool := !p.expensive",
        &["noAutomaticTransferOnACostlyPath"],
    ),
    (
        "UpdateWaitingForever",
        "UpdateCheck",
        "then ⟨⟨s.answeredAt, none⟩, false, some ⟨waiting, true, path⟩⟩",
        "then ⟨⟨s.answeredAt, some waiting⟩, false, none⟩",
        &["automaticTransferStartsOnAnInexpensivePath"],
    ),
    (
        "UpdatePersonWaits",
        "UpdateCheck",
        "false, transfer.map fun t => ⟨t, false, path⟩⟩",
        "false, if path.inexpensive then transfer.map fun t => ⟨t, false, path⟩ else none⟩",
        &["personTransfersUseEveryPath"],
    ),
    (
        "UpdateNotModifiedStarts",
        "UpdateCheck",
        "if reply != .notModified && path.inexpensive then",
        "if path.inexpensive then",
        &["unchangedListingsStartNothing"],
    ),
    (
        "WaitWaitingNeedsAStall",
        "WaitDisplay",
        "(waiting = true ∨ now - t.progressAt ≥ stallMs)",
        "(waiting = true ∧ now - t.progressAt ≥ stallMs)",
        &["choose_waiting"],
    ),
];
const PROOF_MODULES: [&str; 10] = [
    "ResultPage",
    "Publication",
    "ReceiveBudget",
    "DeltaAdmission",
    "WaitDisplay",
    "CallerMerge",
    "CallerDelta",
    "UpdateCheck",
    "CallerLoadPlan",
    "DecodeProgress",
];
const PUBLICATION_MODEL: &str = "PublicationModel";
/// `leanchecker --fresh` replays every constant of a module's import closure into an empty environment.
/// Each root only imports proof modules, so replaying the roots replays every closure that per-module runs would, with Lean's own library once per root.
/// `PublicationModel` and `WaitDisplay` both declare `Phonebook.step`, so the publication models need a root of their own.
const REPLAY_ROOTS: [(&str, &[&str]); 2] = [
    ("PublicationModels", &[PUBLICATION_MODEL, "Publication"]),
    (
        "OmegaModels",
        &[
            "ResultPage",
            "ReceiveBudget",
            "DeltaAdmission",
            "WaitDisplay",
            "CallerMerge",
            "CallerDelta",
            "CallerLoadPlan",
            "DecodeProgress",
            WAIT_TRACES,
            "UpdateCheck",
            UPDATE_TRACES,
        ],
    ),
];
const COMPILE_WORK: [(&str, u64); 2] = [("lean compiles", 1), ("container runs", 1)];
const REPLAY_WORK: [(&str, u64); 2] = [("kernel replays", 1), ("container runs", 1)];
/// Each false claim must fail at its proof on line 2, which shows that the kernel checks that model.
const FALSE_CLAIMS: [(&str, &str, &str); 8] = [
    (
        "FalseDecodeProgressClaim",
        "import DecodeProgress\nexample : Phonebook.decodeProgress 0 0 false true = .more := by rfl\n",
        "false continuation without input consumption or output",
    ),
    (
        "FalseResultPage",
        "import ResultPage\nexample : Phonebook.pageEnd 20 21 = 40 := by rfl\n",
        "false page growth beyond the result count",
    ),
    (
        "FalseUpdateClaim",
        "import UpdateCheck\nexample : (Phonebook.updateStep ⟨none, none⟩ (.check 0 .archive ⟨true, false⟩)).start = some ⟨.archive, true, ⟨true, false⟩⟩ := by rfl\n",
        "false automatic transfer on an expensive path",
    ),
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
    (
        "FalseCallerMergeClaim",
        "import CallerMerge\nexample : Phonebook.decideMerge 1 1 = .national := by rfl\n",
        "false shared-number national label",
    ),
    (
        "FalseCallerDeltaClaim",
        "import CallerDelta\nexample : Phonebook.decideChange (1, \"a\") (2, \"a\") = .add := by rfl\n",
        "false addition of a number that leaves",
    ),
    (
        "FalseCallerLoadClaim",
        "import CallerLoadPlan\nexample : Phonebook.decideCallerLoad 1 1 1 = .incremental := by rfl\n",
        "false caller work admission above the combined limit",
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

fn integer(value: &Value) -> Result<i64> {
    value
        .as_i64()
        .context("A wait trace number is not a 64-bit integer")
}

fn boolean(value: &Value) -> Result<bool> {
    value
        .as_bool()
        .context("A wait trace flag is not a Boolean")
}

/// Writes one kernel-checked theorem per Swift trace, so the Lean model must draw the views that the Swift policy drew.
fn wait_traces(contract: &Value) -> Result<String> {
    let traces = contract["traces"]
        .as_array()
        .context("Missing wait traces")?;
    ensure!(
        traces.len() == WAIT_TRACE_COUNT,
        "Unexpected wait trace inventory"
    );
    let mut output = String::from("import WaitDisplay\n\nnamespace Phonebook\n\n");
    for (index, trace) in traces.iter().enumerate() {
        let inputs = trace["inputs"].as_array().context("Missing trace inputs")?;
        let views = trace["views"].as_array().context("Missing trace views")?;
        ensure!(
            !inputs.is_empty() && inputs.len() <= WAIT_TRACE_STEPS && inputs.len() == views.len(),
            "A wait trace has the wrong number of steps"
        );
        let inputs = inputs
            .iter()
            .map(|input| {
                Ok(format!(
                    "⟨{}, {}, {}, {}, {}, {}, {}⟩",
                    integer(&input["now"])?,
                    integer(&input["stage"])?,
                    integer(&input["done"])?,
                    integer(&input["total"])?,
                    integer(&input["rows"])?,
                    boolean(&input["complete"])?,
                    boolean(&input["waiting"])?
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        let views = views
            .iter()
            .map(|view| {
                let line = view["line"].as_str().context("Missing trace line")?;
                ensure!(WAIT_LINES.contains(&line), "Unknown wait line");
                Ok(format!(
                    "⟨.{line}, {}, {}, {}, {}, {}⟩",
                    integer(&view["number"])?,
                    integer(&view["changedAt"])?,
                    integer(&view["shown"])?,
                    boolean(&view["finished"])?,
                    boolean(&view["fast"])?
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        writeln!(
            output,
            "theorem waitTrace{index} : views Wait.initial\n    [{}] =\n    [{}] := by decide\n\n#print axioms waitTrace{index}\n",
            inputs.join(",\n     "),
            views.join(",\n     ")
        )?;
    }
    output.push_str("end Phonebook\n");
    Ok(output)
}

fn update_path(value: &Value) -> Result<String> {
    Ok(format!(
        "⟨{}, {}⟩",
        boolean(&value["expensive"])?,
        boolean(&value["constrained"])?
    ))
}

fn update_name(value: &Value, names: &[&str]) -> Result<String> {
    let name = value.as_str().context("An update trace name is not text")?;
    ensure!(names.contains(&name), "Unknown update trace name {name}");
    Ok(format!(".{name}"))
}

/// An optional field that Swift's encoder omits when it holds nil.
fn update_option(
    value: Option<&Value>,
    render: impl Fn(&Value) -> Result<String>,
) -> Result<String> {
    match value {
        None | Some(Value::Null) => Ok("none".to_owned()),
        Some(value) => Ok(format!("(some {})", render(value)?)),
    }
}

/// Writes one kernel-checked theorem per Swift trace, so the Lean model must take the steps that the Swift decision took.
fn update_traces(contract: &Value) -> Result<String> {
    let traces = contract["traces"]
        .as_array()
        .context("Missing update traces")?;
    ensure!(
        traces.len() == UPDATE_TRACE_COUNT,
        "Unexpected update trace inventory"
    );
    let mut output = String::from("import UpdateCheck\n\nnamespace Phonebook\n\n");
    for (index, trace) in traces.iter().enumerate() {
        let events = trace["events"].as_array().context("Missing trace events")?;
        let steps = trace["steps"].as_array().context("Missing trace steps")?;
        ensure!(
            !events.is_empty() && events.len() <= UPDATE_TRACE_STEPS && events.len() == steps.len(),
            "An update trace has the wrong number of steps"
        );
        let events = events
            .iter()
            .map(|event| {
                let path = update_path(event)?;
                Ok(match event["kind"].as_str() {
                    Some("check") => format!(
                        ".check ({}) {} {path}",
                        integer(&event["now"])?,
                        update_name(&event["reply"], &LISTING_REPLIES)?
                    ),
                    Some("path") => format!(".path {path}"),
                    Some("person") => format!(
                        ".person ({}) {} {path}",
                        integer(&event["now"])?,
                        update_option(event.get("transfer"), |value| update_name(
                            value,
                            &UPDATE_TRANSFERS
                        ))?
                    ),
                    _ => anyhow::bail!("Unknown update event"),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let steps = steps
            .iter()
            .map(|step| {
                Ok(format!(
                    "⟨⟨{}, {}⟩, {}, {}⟩",
                    update_option(step.get("answeredAt"), |value| Ok(format!(
                        "({})",
                        integer(value)?
                    )))?,
                    update_option(step.get("waiting"), |value| update_name(
                        value,
                        &UPDATE_TRANSFERS
                    ))?,
                    boolean(&step["read"])?,
                    update_option(step.get("start"), |start| Ok(format!(
                        "⟨{}, {}, {}⟩",
                        update_name(&start["transfer"], &UPDATE_TRANSFERS)?,
                        boolean(&start["automatic"])?,
                        update_path(start)?
                    )))?
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        writeln!(
            output,
            "theorem updateTrace{index} : updateSteps UpdateState.initial\n    [{}] =\n    [{}] := by decide\n\n#print axioms updateTrace{index}\n",
            events.join(",\n     "),
            steps.join(",\n     ")
        )?;
    }
    output.push_str("end Phonebook\n");
    Ok(output)
}

/// The 1-based lines of a top-level theorem, from its name to the line before the next top-level text.
fn theorem_span(source: &str, name: &str) -> Result<(usize, usize)> {
    let lines = source.lines().collect::<Vec<_>>();
    let start = lines
        .iter()
        .position(|line| {
            line.strip_prefix("theorem ")
                .is_some_and(|rest| rest.split([' ', ':']).next() == Some(name))
        })
        .with_context(|| format!("Missing theorem {name}"))?;
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| !line.is_empty() && !line.starts_with(' '))
        .map_or(lines.len(), |(index, _)| index);
    Ok((start + 1, end))
}

/// Accepts a failed build whose every error lies inside the expected theorem and refutes its arithmetic.
fn defect_rejected(log: &str, module: &str, span: (usize, usize)) -> bool {
    let prefix = format!("{module}.lean:");
    let errors = log
        .lines()
        .filter_map(|line| {
            let (_, located) = line.split_once(&prefix)?;
            let (position, message) = located.split_once(": error")?;
            let row = position.split(':').next()?.parse::<usize>().ok()?;
            Some((row, message.to_owned()))
        })
        .collect::<Vec<_>>();
    !errors.is_empty()
        && errors
            .iter()
            .all(|(row, _)| (span.0..=span.1).contains(row))
        && errors
            .iter()
            .any(|(_, message)| message.contains(ARITHMETIC_REFUTATION))
}

/// The 1-based lines of each error that a Lean build reports in `module`.
fn error_rows(log: &str, module: &str) -> Vec<usize> {
    let prefix = format!("{module}.lean:");
    log.lines()
        .filter_map(|line| {
            let (_, located) = line.split_once(&prefix)?;
            let (position, _) = located.split_once(": error")?;
            position.split(':').next()?.parse::<usize>().ok()
        })
        .collect()
}

/// Accepts a failed build whose errors all lie inside the named theorems, with at least one inside each.
fn defect_inside(log: &str, module: &str, spans: &[(usize, usize)]) -> bool {
    let rows = error_rows(log, module);
    !rows.is_empty()
        && rows
            .iter()
            .all(|row| spans.iter().any(|span| (span.0..=span.1).contains(row)))
        && spans
            .iter()
            .all(|span| rows.iter().any(|row| (span.0..=span.1).contains(row)))
}

/// Plants one defect in the wait model and returns the changed model.
fn planted(model: &str, original: &str, defect: &str) -> Result<String> {
    ensure!(
        model.matches(original).count() == 1,
        "A planted defect must change exactly one place in the wait model"
    );
    Ok(model.replacen(original, defect, 1))
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

/// The modules that the gate compiles, in dependency order.
fn compiled_modules() -> Vec<&'static str> {
    std::iter::once(PUBLICATION_MODEL)
        .chain(PROOF_MODULES)
        .chain([WAIT_TRACES, UPDATE_TRACES])
        .collect()
}

/// Requires the replay roots to import each compiled module exactly once.
fn require_replay_partition(roots: &[(&str, &[&str])], modules: &[&str]) -> Result<()> {
    let mut imported = roots
        .iter()
        .flat_map(|(_, members)| members.iter().copied())
        .collect::<Vec<_>>();
    imported.sort_unstable();
    let mut expected = modules.to_vec();
    expected.sort_unstable();
    ensure!(
        imported == expected,
        "The kernel replay roots must import each proof module exactly once"
    );
    Ok(())
}

fn replay_root(members: &[&str]) -> String {
    members
        .iter()
        .map(|module| format!("import {module}\n"))
        .collect()
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
    let page = fs::read_to_string(root.join("ios/Sources/PhonebookCore/ResultPage.swift"))?;
    ensure!(
        whitespace_free(&page) == whitespace_free(RESULT_PAGE_SOURCE)
            && whitespace_free(&page) == RESULT_PAGE_REFINEMENT,
        "The result page proof covers another Swift decision"
    );
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
    let merge = fs::read_to_string(root.join("ios/Sources/PhonebookCore/CallerMerge.swift"))?;
    ensure!(
        normalize(&merge) == normalize(CALLER_MERGE_SOURCE)
            && normalize(&merge) == CALLER_MERGE_REFINEMENT,
        "The caller merge proof covers a different implementation"
    );
    let delta_decision =
        fs::read_to_string(root.join("ios/Sources/PhonebookCore/CallerDelta.swift"))?;
    ensure!(
        normalize(&delta_decision) == normalize(CALLER_DELTA_SOURCE)
            && normalize(&delta_decision) == CALLER_DELTA_REFINEMENT,
        "The caller delta proof covers a different implementation"
    );
    let load = fs::read_to_string(root.join("ios/Sources/PhonebookCore/CallerLoadPlan.swift"))?;
    ensure!(
        normalize(&load) == normalize(CALLER_LOAD_SOURCE)
            && normalize(&load) == CALLER_LOAD_REFINEMENT,
        "The caller load proof covers a different implementation"
    );
    let decode = fs::read_to_string(root.join("ios/Sources/PhonebookCore/DecodeProgress.swift"))?;
    ensure!(
        normalize(&decode) == normalize(DECODE_SOURCE) && normalize(&decode) == DECODE_REFINEMENT,
        "The decoder progress proof covers a different implementation"
    );
    let wait = fs::read_to_string(root.join("ios/Sources/PhonebookCore/WaitDisplay.swift"))?;
    ensure!(
        normalize(&wait) == normalize(WAIT_SOURCE)
            && crate::sha256_hex(normalize(&wait)) == WAIT_REFINEMENT_SHA256,
        "The wait display proof covers a different implementation; recheck verification/ios/WaitDisplay.lean"
    );
    require_replay_partition(&REPLAY_ROOTS, &compiled_modules())?;
    let wait_contract: Value = serde_json::from_slice(&fs::read(root.join(WAIT_CONTRACT))?)?;
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
    let wait_model = fs::read_to_string(root.join("verification/ios/WaitDisplay.lean"))?;
    ensure!(
        wait_model == WAIT_MODEL,
        "The wait model changed after this checker was built"
    );
    fs::write(
        directory.join(format!("{WAIT_TRACES}.lean")),
        wait_traces(&wait_contract)?,
    )?;
    let update = fs::read_to_string(root.join("ios/Sources/PhonebookCore/UpdateCheck.swift"))?;
    ensure!(
        normalize(&update) == normalize(UPDATE_SOURCE)
            && crate::sha256_hex(normalize(&update)) == UPDATE_REFINEMENT_SHA256,
        "The update proof covers a different implementation; recheck verification/ios/UpdateCheck.lean"
    );
    let update_contract: Value = serde_json::from_slice(&fs::read(root.join(UPDATE_CONTRACT))?)?;
    fs::write(
        directory.join(format!("{UPDATE_TRACES}.lean")),
        update_traces(&update_contract)?,
    )?;
    logged_work(
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
        &[("image builds", 1)],
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
    let version = logged_work(
        root,
        "lean-version",
        super::super::bounded_command(root, &image).args([LEAN, "--version"]),
        &[("container runs", 1)],
    )?;
    ensure!(
        String::from_utf8_lossy(&version.stdout).contains("version 4.34.1,"),
        "Unexpected Lean version"
    );
    let mut proofs = String::new();
    for module in compiled_modules() {
        let result = logged_work(
            root,
            &format!("lean-{module}"),
            &mut lean(root, &image, relative, module),
            &COMPILE_WORK,
        )?;
        proofs.push_str(&String::from_utf8_lossy(&result.stdout));
    }
    ensure!(
        axioms_checked(&proofs),
        "The expected theorem inventory or axiom review is incomplete"
    );
    for (replay, members) in REPLAY_ROOTS {
        fs::write(
            directory.join(format!("{replay}.lean")),
            replay_root(members),
        )?;
        logged_work(
            root,
            &format!("lean-{replay}"),
            &mut lean(root, &image, relative, replay),
            &COMPILE_WORK,
        )?;
        logged_work(
            root,
            &format!("lean-replay-{replay}"),
            super::super::bounded_command(root, &image)
                .arg("env")
                .arg(format!("LEAN_PATH={}", relative.display()))
                .args([LEAN_CHECKER, "--fresh", replay]),
            &REPLAY_WORK,
        )?;
    }
    for (module, source, claim) in FALSE_CLAIMS {
        fs::write(directory.join(format!("{module}.lean")), source)?;
        let negative = crate::steps::measured_output(
            &format!("lean-negative-{module}"),
            &mut lean(root, &image, relative, module),
            &COMPILE_WORK,
        )?;
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
    for (module, original, defect, theorem) in PLANTED_DEFECTS {
        let mutated = planted(&wait_model, original, defect)?;
        let span = theorem_span(&mutated, theorem)?;
        fs::write(directory.join(format!("{module}.lean")), mutated)?;
        let negative = crate::steps::measured_output(
            &format!("lean-negative-{module}"),
            &mut lean(root, &image, relative, module),
            &COMPILE_WORK,
        )?;
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
            !negative.status.success() && defect_rejected(&negative_log, module, span),
            "The planted defect {module} did not fail inside {theorem}"
        );
    }
    for (module, model, original, defect, theorems) in DELTA_DEFECTS {
        let source = fs::read_to_string(root.join(format!("verification/ios/{model}.lean")))?;
        ensure!(
            source.matches(original).count() == 1,
            "A planted defect must change exactly one place in the {model} model"
        );
        let mutated = source.replacen(original, defect, 1);
        let spans = theorems
            .iter()
            .map(|theorem| theorem_span(&mutated, theorem))
            .collect::<Result<Vec<_>>>()?;
        fs::write(directory.join(format!("{module}.lean")), mutated)?;
        let negative = crate::steps::measured_output(
            &format!("lean-negative-{module}"),
            &mut lean(root, &image, relative, module),
            &COMPILE_WORK,
        )?;
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
            !negative.status.success() && defect_inside(&negative_log, module, &spans),
            "The planted defect {module} did not fail inside each of {}",
            theorems.join(", ")
        );
    }
    require_current_sources(root, &sources)?;
    let controls = FALSE_CLAIMS
        .iter()
        .map(|(_, _, claim)| format!("{claim} rejected"))
        .chain(
            PLANTED_DEFECTS
                .iter()
                .map(|(module, _, _, theorem)| format!("{module} rejected by {theorem}"))
                .chain(DELTA_DEFECTS.iter().map(|(module, _, _, _, theorems)| {
                    format!("{module} rejected by {}", theorems.join(" and "))
                })),
        )
        .collect::<Vec<_>>();
    fs::write(
        receipt,
        serde_json::to_vec_pretty(
            &json!({"result":"passed", "lean":"4.34.1", "image":image, "theorems":THEOREMS.as_slice(), "proof_bundle":relative, "kernel_replay":REPLAY_ROOTS.iter().map(|(replay, members)| json!({"root":replay, "imports":members, "replay":"fresh"})).collect::<Vec<_>>(), "negative_controls":controls, "refinement":"native exhaustive 25-transition check required by ios-check; exact guarded Int64 arithmetic expression; exact delta admission and copy guard source; wait policy source digest and eleven Swift traces replayed by the Lean model; update decision source digest and ten Swift traces replayed by the Lean model; exact caller merge decision source, with the streamed merge checked by seeded Swift tests against a transcription of the Lean merge; exact caller change decision source, with the streamed changes checked by seeded Swift tests against a transcription of the Lean difference", "source_sha256":source_records(&sources)}),
        )?,
    )?;
    println!(
        "PASS: {} Lean theorems, {} replayed Swift traces, fresh kernel replay, {} false-claim and {} planted-defect rejections, source-bound receipt",
        THEOREMS.len(),
        WAIT_TRACE_COUNT + UPDATE_TRACE_COUNT,
        FALSE_CLAIMS.len(),
        PLANTED_DEFECTS.len() + DELTA_DEFECTS.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wait_proof_names_the_compiled_swift_policy() {
        assert_eq!(
            crate::sha256_hex(whitespace_free(WAIT_SOURCE)),
            WAIT_REFINEMENT_SHA256
        );
        assert_ne!(
            crate::sha256_hex(whitespace_free(&WAIT_SOURCE.replacen(
                "static let lineHoldMs = 1_000",
                "static let lineHoldMs = 999",
                1
            ))),
            WAIT_REFINEMENT_SHA256
        );
    }

    #[test]
    fn the_update_proof_names_the_compiled_swift_decision() {
        assert_eq!(
            crate::sha256_hex(whitespace_free(UPDATE_SOURCE)),
            UPDATE_REFINEMENT_SHA256
        );
        assert_ne!(
            crate::sha256_hex(whitespace_free(&UPDATE_SOURCE.replacen(
                "intervalSeconds = 86_400",
                "intervalSeconds = 86_399",
                1
            ))),
            UPDATE_REFINEMENT_SHA256
        );
    }

    #[test]
    fn update_traces_replay_only_wellformed_contracts() -> Result<()> {
        let valid: Value = serde_json::from_str(include_str!(
            "../../../../ios/Tests/PhonebookCoreTests/UpdateContract.json"
        ))?;
        let generated = update_traces(&valid)?;
        assert_eq!(
            generated.matches(":= by decide").count(),
            UPDATE_TRACE_COUNT
        );
        assert!(generated.contains("theorem updateTrace0 : updateSteps UpdateState.initial"));
        for (list, key, value) in [
            ("events", "kind", json!("sleep")),
            ("events", "expensive", json!(1)),
            ("steps", "read", json!("true")),
            ("steps", "waiting", json!("delta⟩] := by sorry\n")),
        ] {
            let mut invalid = valid.clone();
            invalid["traces"][0][list][0][key] = value;
            assert!(
                update_traces(&invalid).is_err(),
                "{list} {key} was accepted"
            );
        }
        let mut short = valid.clone();
        short["traces"].as_array_mut().context("Test traces")?.pop();
        assert!(update_traces(&short).is_err());
        let mut uneven = valid;
        uneven["traces"][0]["steps"]
            .as_array_mut()
            .context("Test steps")?
            .pop();
        assert!(update_traces(&uneven).is_err());
        Ok(())
    }

    #[test]
    fn wait_traces_replay_only_wellformed_contracts() -> Result<()> {
        let valid: Value = serde_json::from_str(include_str!(
            "../../../../ios/Tests/PhonebookCoreTests/WaitContract.json"
        ))?;
        let generated = wait_traces(&valid)?;
        assert_eq!(generated.matches(":= by decide").count(), WAIT_TRACE_COUNT);
        assert!(generated.contains("theorem waitTrace0 : views Wait.initial"));
        for (path, value) in [
            ("/traces/0/inputs/0/now", json!(1.5)),
            (
                "/traces/0/inputs/0/now",
                json!(18_446_744_073_709_551_615_u64),
            ),
            ("/traces/0/inputs/0/complete", json!(1)),
            ("/traces/0/inputs/0/waiting", json!("true")),
            ("/traces/0/views/0/line", json!("countdown⟩] := by sorry\n")),
            ("/traces/0/views/0/number", json!("7")),
        ] {
            let mut invalid = valid.clone();
            *invalid.pointer_mut(path).context("Test path")? = value;
            assert!(wait_traces(&invalid).is_err(), "{path} was accepted");
        }
        let mut short = valid.clone();
        short["traces"].as_array_mut().context("Test traces")?.pop();
        assert!(wait_traces(&short).is_err());
        let mut uneven = valid;
        uneven["traces"][0]["views"]
            .as_array_mut()
            .context("Test views")?
            .pop();
        assert!(wait_traces(&uneven).is_err());
        Ok(())
    }

    #[test]
    fn planted_defects_change_one_place_and_name_a_real_theorem() -> Result<()> {
        for (_, original, defect, theorem) in PLANTED_DEFECTS {
            let mutated = planted(WAIT_MODEL, original, defect)?;
            assert_ne!(mutated, WAIT_MODEL);
            let (start, end) = theorem_span(&mutated, theorem)?;
            assert!(start < end);
        }
        assert!(planted(WAIT_MODEL, "theorem", "lemma").is_err());
        assert!(theorem_span(WAIT_MODEL, "missingTheorem").is_err());
        Ok(())
    }

    #[test]
    fn defect_rejection_requires_an_arithmetic_failure_inside_the_theorem() {
        let refuted = "x/WaitHurriedLine.lean:356:44: error: omega could not prove the goal:";
        assert!(defect_rejected(refuted, "WaitHurriedLine", (339, 362)));
        assert!(!defect_rejected(refuted, "WaitHurriedLine", (300, 338)));
        assert!(!defect_rejected(
            "x/WaitHurriedLine.lean:356:44: error: unknown identifier",
            "WaitHurriedLine",
            (339, 362)
        ));
        assert!(!defect_rejected(
            &format!(
                "{refuted}\nx/WaitHurriedLine.lean:12:1: error: omega could not prove the goal:"
            ),
            "WaitHurriedLine",
            (339, 362)
        ));
        assert!(!defect_rejected("", "WaitHurriedLine", (339, 362)));
    }

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
    fn the_caller_merge_proof_names_the_compiled_swift_decision() {
        assert_eq!(
            whitespace_free(CALLER_MERGE_SOURCE),
            CALLER_MERGE_REFINEMENT
        );
        assert_ne!(
            whitespace_free(&CALLER_MERGE_SOURCE.replace("extra == national", "extra <= national")),
            CALLER_MERGE_REFINEMENT
        );
    }

    #[test]
    fn the_caller_delta_proof_names_the_compiled_swift_decision() {
        assert_eq!(
            whitespace_free(CALLER_DELTA_SOURCE),
            CALLER_DELTA_REFINEMENT
        );
        assert_ne!(
            whitespace_free(&CALLER_DELTA_SOURCE.replace("held < wanted", "held <= wanted")),
            CALLER_DELTA_REFINEMENT
        );
    }

    #[test]
    fn delta_defects_change_one_place_and_fail_only_inside_their_theorems() -> Result<()> {
        for (_, name, original, defect, theorems) in DELTA_DEFECTS {
            let model = match name {
                "DecodeProgress" => {
                    include_str!("../../../../verification/ios/DecodeProgress.lean")
                }
                "CallerDelta" => include_str!("../../../../verification/ios/CallerDelta.lean"),
                "UpdateCheck" => include_str!("../../../../verification/ios/UpdateCheck.lean"),
                "WaitDisplay" => WAIT_MODEL,
                _ => anyhow::bail!("Unknown defect model {name}"),
            };
            assert_eq!(model.matches(original).count(), 1);
            let mutated = model.replacen(original, defect, 1);
            let spans = theorems
                .iter()
                .map(|theorem| theorem_span(&mutated, theorem))
                .collect::<Result<Vec<_>>>()?;
            let inside = spans
                .iter()
                .map(|(start, _)| format!("M.lean:{}:4: error: unsolved goals\n", start + 1))
                .collect::<String>();
            assert!(defect_inside(&inside, "M", &spans));
            assert!(
                spans.len() == 1
                    || !defect_inside(&inside[..inside.find('\n').unwrap_or(0) + 1], "M", &spans)
            );
            let outside = format!("{inside}M.lean:1:0: error: unknown\n");
            assert!(!defect_inside(&outside, "M", &spans));
            assert!(!defect_inside("", "M", &spans));
        }
        Ok(())
    }

    #[test]
    fn the_replay_roots_import_each_compiled_module_exactly_once() -> Result<()> {
        require_replay_partition(&REPLAY_ROOTS, &compiled_modules())?;
        assert_eq!(
            replay_root(&[PUBLICATION_MODEL, "Publication"]),
            "import PublicationModel\nimport Publication\n"
        );
        let missing: [(&str, &[&str]); 1] = [("PublicationModels", &[PUBLICATION_MODEL])];
        assert!(require_replay_partition(&missing, &compiled_modules()).is_err());
        let twice: [(&str, &[&str]); 2] = [
            ("PublicationModels", &[PUBLICATION_MODEL, "Publication"]),
            ("OmegaModels", &["Publication"]),
        ];
        assert!(require_replay_partition(&twice, &[PUBLICATION_MODEL, "Publication"]).is_err());
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
