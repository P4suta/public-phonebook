import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as v from "valibot";
import { DigestSchema } from "../src/core/models.ts";
import { controlStoreFromEnvironment } from "./control-store.ts";
import { exportOutputs } from "./publish.ts";
import {
  type CandidateStage,
  candidateEvidenceAdmission,
  candidateStages,
  type RunProvenance,
  recordCandidateEvidence,
  recordCandidateObservation,
  runProvenance,
} from "./release-store.ts";
import { stageExpectations, trackedFiles } from "./stage-inputs.ts";
import { cleanTree } from "./verification-receipt.ts";

const commandArgumentOffset = 2;
const stageEvidenceFormat = 2;
const observationFormat = 1;
const performanceReport = ".local/search-performance.json";
/** Every option takes exactly one value. */
const optionWidth = 2;

/** The candidate workflow job whose success proves each stage; the data job's fetch runs the complete bundle check. */
export const stageJobs: Readonly<Record<CandidateStage, string>> = {
  check: "check",
  data: "data",
  phones: "data",
  parity: "parity",
  prove: "prove",
  e2e: "e2e",
  "ios-prove": "ios-prove",
  "ios-check": "ios-check",
};

const JobResultSchema = v.picklist([
  "success",
  "failure",
  "cancelled",
  "skipped",
]);
type JobResult = v.InferOutput<typeof JobResultSchema>;
const StageListSchema = v.array(v.picklist(candidateStages));

export interface RecordDecision {
  readonly passed: readonly CandidateStage[];
  readonly unfinished: readonly CandidateStage[];
}

/** Records each planned stage whose job succeeded, and names the planned stages that didn't, so the run fails after keeping what passed. */
export function recordDecision(
  missing: readonly CandidateStage[],
  results: Readonly<Record<string, JobResult>>,
): RecordDecision {
  const passed: CandidateStage[] = [];
  const unfinished: CandidateStage[] = [];
  for (const stage of missing)
    (results[stageJobs[stage]] === "success" ? passed : unfinished).push(stage);
  return { passed, unfinished };
}

export function recordingAuthority(
  provenance: RunProvenance,
  sourceTree: string | null,
): asserts sourceTree is string {
  if (provenance.kind !== "github-actions")
    throw new Error("Only a GitHub Actions run records candidate evidence");
  if (!sourceTree)
    throw new Error("Candidate evidence requires a clean committed tree");
}

interface Arguments {
  readonly command: "plan" | "record";
  readonly dataset: string;
  readonly missing: readonly CandidateStage[];
  readonly results: Readonly<Record<string, JobResult>>;
}

export function parseEvidenceArguments(args: readonly string[]): Arguments {
  const [command, ...rest] = args;
  let dataset: string | null = null;
  let missing: readonly CandidateStage[] = [];
  const results: Record<string, JobResult> = {};
  for (let index = 0; index < rest.length; index += optionWidth) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--dataset") dataset = v.parse(DigestSchema, value);
    else if (flag === "--missing")
      missing = v.parse(StageListSchema, JSON.parse(value));
    else if (flag === "--result") {
      const [job = "", result = ""] = value.split("=");
      if (!Object.values(stageJobs).includes(job))
        throw new Error(`Unknown candidate job: ${job}`);
      results[job] = v.parse(JobResultSchema, result);
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if ((command !== "plan" && command !== "record") || dataset === null)
    throw new Error(
      "Usage: candidate-evidence plan|record --dataset SHA256 [--missing JSON] [--result JOB=RESULT]...",
    );
  return { command, dataset, missing, results };
}

async function plan(dataset: string): Promise<void> {
  const store = controlStoreFromEnvironment();
  const admissions = await candidateEvidenceAdmission(
    store,
    stageExpectations(await trackedFiles(), dataset),
  );
  const missing = admissions
    .filter((admission) => admission.decision !== "admit")
    .map((admission) => admission.stage);
  await exportOutputs({ missing: JSON.stringify(missing) });
  console.info(
    JSON.stringify({
      operation: "candidate.plan",
      dataset,
      stages: admissions.map(({ stage, inputsSha256, decision }) => ({
        stage,
        inputsSha256,
        decision,
      })),
      missing,
    }),
  );
}

async function performanceObservation(): Promise<Record<
  string,
  unknown
> | null> {
  try {
    return v.parse(
      v.record(v.string(), v.unknown()),
      JSON.parse(await readFile(resolve(performanceReport), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

async function record(options: Arguments): Promise<void> {
  const provenance = runProvenance();
  const sourceTree = await cleanTree();
  recordingAuthority(provenance, sourceTree);
  const store = controlStoreFromEnvironment();
  const expected = stageExpectations(await trackedFiles(), options.dataset);
  const decision = recordDecision(options.missing, options.results);
  for (const stage of decision.passed)
    await recordCandidateEvidence(store, {
      formatVersion: stageEvidenceFormat,
      stage,
      inputsSha256: expected[stage].inputsSha256,
      manifestSha256: expected[stage].manifestSha256,
      sourceTree,
      result: "passed",
      provenance,
    });
  const observation = decision.passed.includes("parity")
    ? await performanceObservation()
    : null;
  if (observation)
    await recordCandidateObservation(store, {
      formatVersion: observationFormat,
      name: "search-performance",
      sourceTree,
      manifestSha256: options.dataset,
      provenance,
      report: observation,
    });
  console.info(
    JSON.stringify({
      operation: "candidate.record",
      dataset: options.dataset,
      recorded: decision.passed,
      unfinished: decision.unfinished,
      observation: observation ? "recorded" : "none",
    }),
  );
  if (decision.unfinished.length)
    throw new Error(
      `Candidate stages didn't pass: ${decision.unfinished.join(", ")}`,
    );
}

if (process.argv[1] === resolve("tools/candidate-evidence.ts")) {
  const options = parseEvidenceArguments(
    process.argv.slice(commandArgumentOffset),
  );
  if (options.command === "plan") await plan(options.dataset);
  else await record(options);
}
