import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import * as v from "valibot";
import { requireBuildBudget } from "./build-budget.ts";
import { checkedDataBundle } from "./check-data.ts";
import { defaultBundle, localBundleVariable } from "./local-bundle.ts";
import { command, requireCommand } from "./process.ts";
import {
  type CandidateEvidence,
  type CandidateStage,
  candidateStages,
  releaseLock,
  runProvenance,
} from "./release-store.ts";
import { fileDigest } from "./snapshot.ts";
import { stageInputDigest, stageInputs, trackedFiles } from "./stage-inputs.ts";
import {
  cleanTree,
  saveStageReceipt,
  saveVerificationReceipt,
} from "./verification-receipt.ts";

const commandArgumentOffset = 2;
const stageEvidenceFormat = 2;
const iosCheckManifest = [
  "run",
  "--locked",
  "--manifest-path",
  "tools/ios-check/Cargo.toml",
  "--",
] as const;

export interface TestArguments {
  readonly bundle: string;
  readonly stages: readonly CandidateStage[];
}

export function parseTestArguments(args: readonly string[]): TestArguments {
  let bundle = defaultBundle;
  const stages: CandidateStage[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--bundle" && value) {
      bundle = value;
      index += 1;
    } else if (flag === "--stage" && value) {
      const stage = v.parse(v.picklist(candidateStages), value);
      if (stages.includes(stage))
        throw new Error(`The stage ${stage} is listed twice`);
      stages.push(stage);
      index += 1;
    } else
      throw new Error(
        `Usage: test [--bundle DIRECTORY] [--stage ${candidateStages.join("|")}]...`,
      );
  }
  return {
    bundle: resolve(bundle),
    stages: stages.length
      ? candidateStages.filter((stage) => stages.includes(stage))
      : candidateStages,
  };
}

/** The candidate's check stage runs the fast gate and the build checks that pull requests skip. */
export const checkStageScripts = ["check", "check:build"] as const;
export const performanceReport = ".local/search-performance.json";

/** Compares the device search with the API on the bundle, which the seeded local state must hold. */
export function parityCommand(bundle: string): readonly string[] {
  return ["tools/search-parity.ts", bundle];
}

export function performanceCommand(bundle: string): readonly string[] {
  return ["tools/search-performance.ts", bundle, "--output", performanceReport];
}

/** Names the bundle for the e2e checks that compare the server with its files. */
export function e2eEnvironment(
  bundle: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...environment, [localBundleVariable]: bundle };
}

export function stageRunner(
  bundle: string,
): Record<CandidateStage, () => Promise<void>> {
  return {
    check: async (): Promise<void> => {
      for (const script of checkStageScripts)
        await requireCommand("npm", ["run", script]);
      await requireBuildBudget();
    },
    data: async (): Promise<void> => {
      await checkedDataBundle(bundle);
    },
    parity: () => requireCommand("node", parityCommand(bundle)),
    phones: () =>
      requireCommand("npm", [
        "run",
        "data:phones",
        "--",
        bundle,
        ".local/phone-quality.json",
      ]),
    prove: () => requireCommand("npm", ["run", "prove"]),
    e2e: () =>
      requireCommand("npm", ["run", "e2e"], undefined, e2eEnvironment(bundle)),
    "ios-prove": () => requireCommand("cargo", [...iosCheckManifest, "prove"]),
    "ios-check": () => requireCommand("cargo", [...iosCheckManifest, "check"]),
  };
}

/** Measures search performance after the parity stage; a failed measurement leaves the verdict alone and says so. */
export async function observePerformance(
  bundle: string,
): Promise<Record<string, unknown> | null> {
  const run = await command("node", performanceCommand(bundle));
  if (run.code !== 0) {
    console.warn(
      JSON.stringify({
        operation: "test.observation",
        name: "search-performance",
        result: "unavailable",
        exitCode: run.code,
      }),
    );
    return null;
  }
  const report: unknown = JSON.parse(await readFile(performanceReport, "utf8"));
  return v.parse(v.record(v.string(), v.unknown()), report);
}

/** Runs the selected stages and writes a local receipt per stage; the candidate workflow records evidence in its own job. */
async function main(args: readonly string[]): Promise<void> {
  const options = parseTestArguments(args);
  const manifestPath = resolve(options.bundle, "manifest.ready.json");
  const readsDataset = options.stages.some(
    (stage) => stageInputs[stage].dataset,
  );
  const provenance = runProvenance();
  const unlock = await releaseLock("build");
  try {
    const tree = await cleanTree();
    const files = tree ? await trackedFiles() : null;
    const manifest = readsDataset ? await fileDigest(manifestPath) : null;
    const complete = options.stages.length === candidateStages.length;
    if (complete)
      await rm(resolve(".local/test-receipt.json"), { force: true });
    const run = stageRunner(options.bundle);
    const passed: CandidateEvidence[] = [];
    for (const stage of options.stages) {
      await run[stage]();
      if (tree && files) {
        const stageManifest = stageInputs[stage].dataset ? manifest : null;
        passed.push({
          formatVersion: stageEvidenceFormat,
          stage,
          inputsSha256: stageInputDigest(stage, files, stageManifest),
          manifestSha256: stageManifest,
          sourceTree: tree,
          result: "passed",
          provenance,
        });
      }
    }
    if (manifest && manifest !== (await fileDigest(manifestPath)))
      throw new Error("The verification dataset changed during testing");
    if (tree && tree !== (await cleanTree()))
      throw new Error("The committed source changed during testing");
    for (const evidence of passed) await saveStageReceipt(evidence);
    if (tree && complete && manifest)
      await saveVerificationReceipt(tree, manifest);
    if (options.stages.includes("parity"))
      await observePerformance(options.bundle);
    console.info(
      JSON.stringify({
        operation: "test",
        sourceTree: tree,
        manifestSha256: manifest,
        stages: options.stages,
        receipt: tree ? "recorded" : "dirty-source",
        result: "passed",
      }),
    );
  } finally {
    await unlock();
  }
}

if (process.argv[1] === resolve("tools/test.ts"))
  await main(process.argv.slice(commandArgumentOffset));
