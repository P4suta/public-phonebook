import { join, resolve } from "node:path";
import * as v from "valibot";
import { releaseControl } from "../src/core/environment.ts";
import { DigestSchema } from "../src/core/models.ts";
import {
  evidenceAdmission,
  type ReleasePreflight,
  releasePreflight,
} from "../src/core/publication-policy.ts";
import { command, requireCommand } from "./process.ts";
import {
  type CandidateEvidence,
  type CandidateStage,
  candidateStages,
  type ExpectedStage,
  provenanceSigner,
} from "./release-store.ts";
import { fileDigest } from "./snapshot.ts";
import { stageExpectations, trackedFiles } from "./stage-inputs.ts";
import { cleanTree, readStageReceipt } from "./verification-receipt.ts";

const commandArgumentOffset = 2;
const runSearchLimit = 20;
const runSearchAttempts = 12;
const runSearchIntervalMs = 5000;
const watchIntervalSeconds = 30;
const commandNameParts = 2;

export const releaseWorkflow = releaseControl.releaseWorkflow;

export function dispatchArguments(dataset: string): readonly string[] {
  return [
    "workflow",
    "run",
    releaseWorkflow,
    "--repo",
    releaseControl.repository,
    "--ref",
    releaseControl.releaseBranch,
    "-f",
    `dataset=${v.parse(DigestSchema, dataset)}`,
  ];
}

export function runListArguments(actor: string): readonly string[] {
  return [
    "run",
    "list",
    "--repo",
    releaseControl.repository,
    "--workflow",
    releaseWorkflow,
    "--branch",
    releaseControl.releaseBranch,
    "--event",
    "workflow_dispatch",
    "--user",
    actor,
    "--limit",
    String(runSearchLimit),
    "--json",
    "databaseId,url",
  ];
}

export function watchArguments(runId: number): readonly string[] {
  return [
    "run",
    "watch",
    String(runId),
    "--repo",
    releaseControl.repository,
    "--exit-status",
    "--interval",
    String(watchIntervalSeconds),
  ];
}

const RunListSchema = v.array(
  v.object({
    databaseId: v.pipe(v.number(), v.integer(), v.minValue(1)),
    url: v.pipe(v.string(), v.url()),
  }),
);
export type DispatchedRun = v.InferOutput<typeof RunListSchema>[number];

export function runIds(runs: unknown): ReadonlySet<number> {
  return new Set(v.parse(RunListSchema, runs).map((run) => run.databaseId));
}

/** Returns the one listed run that `before` lacks, null while none has appeared, and refuses to choose among several. */
export function dispatchedRun(
  before: ReadonlySet<number>,
  runs: unknown,
): DispatchedRun | null {
  const appeared = v
    .parse(RunListSchema, runs)
    .filter((run) => !before.has(run.databaseId));
  if (appeared.length > 1)
    throw new Error(
      `Several release runs appeared after the dispatch: ${appeared.map((run) => run.url).join(", ")}`,
    );
  return appeared[0] ?? null;
}

async function gh(args: readonly string[]): Promise<string> {
  const result = await command("gh", args, true);
  if (result.code !== 0)
    throw new Error(
      `gh ${args.slice(0, commandNameParts).join(" ")} failed: ${result.stderr.trim()}`,
    );
  return result.stdout;
}

export interface ReleaseArguments {
  readonly dataset: string;
  readonly bundle: string;
}

const usage = "Usage: release DATASET_MANIFEST_SHA256 [--bundle DIRECTORY]";

export function parseReleaseArguments(
  args: readonly string[],
): ReleaseArguments {
  const [dataset, flag, value, ...extra] = args;
  if (
    dataset === undefined ||
    extra.length > 0 ||
    (flag !== undefined && (flag !== "--bundle" || !value))
  )
    throw new Error(usage);
  const digest = v.parse(DigestSchema, dataset);
  return {
    dataset: digest,
    bundle: resolve(value ?? join(".local/datasets", digest)),
  };
}

/** Only `tools/test.ts` on the owner's machine writes local stage receipts. */
const localSigner = "local";

/** Lists, in candidate order, the stages whose local receipt doesn't admit the checked-out inputs and the dataset. */
export function missingStages(
  expected: Readonly<Record<CandidateStage, ExpectedStage>>,
  receipts: Readonly<Partial<Record<CandidateStage, CandidateEvidence>>>,
): readonly CandidateStage[] {
  return candidateStages.filter((stage) => {
    const receipt = receipts[stage];
    return (
      evidenceAdmission(
        receipt !== undefined,
        receipt?.inputsSha256 ?? "",
        expected[stage].inputsSha256,
        receipt?.manifestSha256 ?? "",
        expected[stage].manifestSha256 ?? "",
        receipt ? provenanceSigner(receipt.provenance) : "",
        localSigner,
        receipt?.result === "passed",
      ) !== "admit"
    );
  });
}

export interface PreflightFacts {
  readonly clean: boolean;
  readonly head: string;
  readonly releaseHead: string;
  readonly bundleManifest: string;
  readonly dataset: string;
  readonly missing: readonly CandidateStage[];
}

export type PreflightRefusal = Exclude<
  ReleasePreflight,
  "run-stages" | "dispatch"
>;

export type PreflightPlan =
  | { readonly action: "refuse"; readonly reason: PreflightRefusal }
  | { readonly action: "run"; readonly stages: readonly CandidateStage[] }
  | { readonly action: "dispatch" };

/** Turns the proved preflight decision into the stages to run or the reason to refuse. */
export function preflightPlan(facts: PreflightFacts): PreflightPlan {
  const decision = releasePreflight(
    facts.clean,
    facts.head,
    facts.releaseHead,
    facts.bundleManifest,
    facts.dataset,
    facts.missing.length,
  );
  if (decision === "run-stages")
    return { action: "run", stages: facts.missing };
  if (decision === "dispatch") return { action: "dispatch" };
  return { action: "refuse", reason: decision };
}

/** Stages that compare the server with the bundle read the seeded local state and the built Worker. */
const serverStages: readonly CandidateStage[] = ["parity", "e2e"];

export function stageCommands(
  bundle: string,
  stages: readonly CandidateStage[],
): readonly (readonly [string, readonly string[]])[] {
  const prepare: (readonly [string, readonly string[]])[] = stages.some(
    (stage) => serverStages.includes(stage),
  )
    ? [
        ["node", ["tools/local-data.ts", bundle]],
        ["npm", ["run", "build"]],
      ]
    : [];
  return [
    ...prepare,
    [
      "node",
      [
        "tools/test.ts",
        "--bundle",
        bundle,
        ...stages.flatMap((stage) => ["--stage", stage]),
      ],
    ],
  ];
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function gitValue(args: readonly string[]): Promise<string> {
  const result = await command("git", args, true);
  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function localReceipts(
  expected: Readonly<Record<CandidateStage, ExpectedStage>>,
): Promise<Partial<Record<CandidateStage, CandidateEvidence>>> {
  const receipts: Partial<Record<CandidateStage, CandidateEvidence>> = {};
  for (const stage of candidateStages) {
    try {
      receipts[stage] = await readStageReceipt(
        resolve(".local"),
        expected[stage].inputsSha256,
        stage,
      );
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return receipts;
}

async function inspect(options: ReleaseArguments): Promise<PreflightPlan> {
  const tree = await cleanTree();
  const head = await gitValue(["rev-parse", "HEAD"]);
  const releaseHead = await gitValue([
    "rev-parse",
    `origin/${releaseControl.releaseBranch}`,
  ]);
  let bundleManifest = "";
  try {
    bundleManifest = await fileDigest(
      join(options.bundle, "manifest.ready.json"),
    );
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const comparable =
    tree !== null && head === releaseHead && bundleManifest === options.dataset;
  const expected = comparable
    ? stageExpectations(await trackedFiles(), options.dataset)
    : null;
  return preflightPlan({
    clean: tree !== null,
    head,
    releaseHead,
    bundleManifest,
    dataset: options.dataset,
    missing: expected
      ? missingStages(expected, await localReceipts(expected))
      : candidateStages,
  });
}

function refusalMessage(
  reason: PreflightRefusal,
  options: ReleaseArguments,
): string {
  if (reason === "dirty-tree")
    return "The release preflight needs a clean checkout; commit or remove every change first";
  if (reason === "not-release-head")
    return `The release preflight needs the checkout at origin/${releaseControl.releaseBranch}; check it out and retry`;
  return `The bundle at ${options.bundle} doesn't hold dataset ${options.dataset}; fetch it with just data-fetch or pass --bundle`;
}

/** Runs every candidate stage that lacks a local pass for the exact inputs, and refuses to dispatch unless all of them pass. */
export async function requireReleasePreflight(
  options: ReleaseArguments,
): Promise<void> {
  await requireCommand("git", [
    "fetch",
    "--quiet",
    "origin",
    releaseControl.releaseBranch,
  ]);
  let plan = await inspect(options);
  if (plan.action === "run") {
    console.info(
      JSON.stringify({ operation: "release.preflight", run: plan.stages }),
    );
    for (const [executable, args] of stageCommands(options.bundle, plan.stages))
      await requireCommand(executable, args);
    plan = await inspect(options);
  }
  if (plan.action === "run")
    throw new Error(
      `Candidate stages still lack a local pass: ${plan.stages.join(", ")}`,
    );
  if (plan.action === "refuse")
    throw new Error(refusalMessage(plan.reason, options));
  console.info(
    JSON.stringify({
      operation: "release.preflight",
      dataset: options.dataset,
      stages: candidateStages,
      result: "passed",
    }),
  );
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseReleaseArguments(args);
  const { dataset } = options;
  await requireReleasePreflight(options);
  const actor = (await gh(["api", "user", "--jq", ".login"])).trim();
  const before = runIds(JSON.parse(await gh(runListArguments(actor))));
  await gh(dispatchArguments(dataset));
  let run: DispatchedRun | null = null;
  for (let attempt = 0; attempt < runSearchAttempts && !run; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, runSearchIntervalMs));
    run = dispatchedRun(before, JSON.parse(await gh(runListArguments(actor))));
  }
  if (!run)
    throw new Error(
      `The ${releaseWorkflow} dispatch started no visible run; check the Actions page`,
    );
  console.info(
    JSON.stringify({
      operation: "release.dispatch",
      workflow: releaseWorkflow,
      dataset,
      run: run.databaseId,
      url: run.url,
    }),
  );
  await requireCommand("gh", watchArguments(run.databaseId));
}

if (process.argv[1] === resolve("tools/release.ts"))
  await main(process.argv.slice(commandArgumentOffset));
