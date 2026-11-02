import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import * as v from "valibot";
import { checkDataBundle } from "./check-data.ts";
import { controlStoreFromEnvironment } from "./control-store.ts";
import { requireCommand } from "./process.ts";
import {
  type CandidateEvidence,
  type CandidateStage,
  candidateStages,
  type RunProvenance,
  recordCandidateEvidence,
  releaseLock,
  runProvenance,
} from "./release-store.ts";
import { fileDigest } from "./snapshot.ts";
import {
  cleanTree,
  saveStageReceipt,
  saveVerificationReceipt,
} from "./verification-receipt.ts";

const commandArgumentOffset = 2;
const defaultBundle = ".local/phonebook";
const evidenceFormat = 1;

export interface TestArguments {
  readonly bundle: string;
  readonly stages: readonly CandidateStage[];
  readonly record: boolean;
}

export function parseTestArguments(args: readonly string[]): TestArguments {
  let bundle = defaultBundle;
  const stages: CandidateStage[] = [];
  let record = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--record") record = true;
    else if (flag === "--bundle" && value) {
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
        `Usage: test [--bundle DIRECTORY] [--stage ${candidateStages.join("|")}]... [--record]`,
      );
  }
  return {
    bundle: resolve(bundle),
    stages: stages.length
      ? candidateStages.filter((stage) => stages.includes(stage))
      : candidateStages,
    record,
  };
}

/** The candidate's check stage runs the fast gate and the build checks that pull requests skip. */
export const checkStageScripts = ["check", "check:build"] as const;

export function stageRunner(
  bundle: string,
): Record<CandidateStage, () => Promise<void>> {
  return {
    check: async (): Promise<void> => {
      for (const script of checkStageScripts)
        await requireCommand("npm", ["run", script]);
    },
    data: async (): Promise<void> => {
      await checkDataBundle(bundle);
    },
    phones: () =>
      requireCommand("npm", [
        "run",
        "data:phones",
        "--",
        bundle,
        ".local/phone-quality.json",
      ]),
    prove: () => requireCommand("npm", ["run", "prove"]),
    e2e: () => requireCommand("npm", ["run", "e2e"]),
  };
}

export function recordingAuthority(
  record: boolean,
  provenance: RunProvenance,
  sourceTree: string | null,
): void {
  if (!record) return;
  if (provenance.kind !== "github-actions")
    throw new Error("Only a GitHub Actions run records candidate evidence");
  if (!sourceTree)
    throw new Error("Candidate evidence requires a clean committed tree");
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseTestArguments(args);
  const manifestPath = resolve(options.bundle, "manifest.ready.json");
  const provenance = runProvenance();
  const unlock = await releaseLock("build");
  try {
    const tree = await cleanTree();
    recordingAuthority(options.record, provenance, tree);
    const store = options.record ? controlStoreFromEnvironment() : null;
    const manifest = await fileDigest(manifestPath);
    const complete = options.stages.length === candidateStages.length;
    if (complete)
      await rm(resolve(".local/test-receipt.json"), { force: true });
    const run = stageRunner(options.bundle);
    const passed: CandidateEvidence[] = [];
    for (const stage of options.stages) {
      await run[stage]();
      if (tree)
        passed.push({
          formatVersion: evidenceFormat,
          stage,
          sourceTree: tree,
          manifestSha256: manifest,
          result: "passed",
          provenance,
        });
    }
    if (manifest !== (await fileDigest(manifestPath)))
      throw new Error("The verification dataset changed during testing");
    if (tree && tree !== (await cleanTree()))
      throw new Error("The committed source changed during testing");
    for (const evidence of passed) {
      await saveStageReceipt(evidence);
      if (store) await recordCandidateEvidence(store, evidence);
    }
    if (tree && complete) await saveVerificationReceipt(tree, manifest);
    console.info(
      JSON.stringify({
        operation: "test",
        sourceTree: tree,
        manifestSha256: manifest,
        stages: options.stages,
        receipt: tree ? "recorded" : "dirty-source",
        evidence: store ? "recorded" : "local",
        result: "passed",
      }),
    );
  } finally {
    await unlock();
  }
}

if (process.argv[1] === resolve("tools/test.ts"))
  await main(process.argv.slice(commandArgumentOffset));
