import { resolve } from "node:path";
import * as v from "valibot";
import { releaseControl } from "../src/core/environment.ts";
import { DigestSchema } from "../src/core/models.ts";
import { command, requireCommand } from "./process.ts";

const commandArgumentOffset = 2;
const requiredArguments = 1;
const runSearchLimit = 20;
const runSearchAttempts = 12;
const runSearchIntervalMs = 5000;
const clockSkewMs = 60000;
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
    "databaseId,createdAt,url",
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
    createdAt: v.pipe(v.string(), v.isoTimestamp()),
    url: v.pipe(v.string(), v.url()),
  }),
);
export type DispatchedRun = v.InferOutput<typeof RunListSchema>[number];

export function dispatchedRun(
  runs: unknown,
  dispatchedAtMs: number,
): DispatchedRun | null {
  const candidates = v
    .parse(RunListSchema, runs)
    .filter((run) => Date.parse(run.createdAt) >= dispatchedAtMs - clockSkewMs)
    .sort(
      (first, second) =>
        Date.parse(first.createdAt) - Date.parse(second.createdAt),
    );
  return candidates[0] ?? null;
}

async function gh(args: readonly string[]): Promise<string> {
  const result = await command("gh", args, true);
  if (result.code !== 0)
    throw new Error(
      `gh ${args.slice(0, commandNameParts).join(" ")} failed: ${result.stderr.trim()}`,
    );
  return result.stdout;
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length !== requiredArguments)
    throw new Error("Usage: release DATASET_MANIFEST_SHA256");
  const dataset = v.parse(DigestSchema, args[0]);
  const actor = (await gh(["api", "user", "--jq", ".login"])).trim();
  const dispatchedAtMs = Date.now();
  await gh(dispatchArguments(dataset));
  let run: DispatchedRun | null = null;
  for (let attempt = 0; attempt < runSearchAttempts && !run; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, runSearchIntervalMs));
    run = dispatchedRun(
      JSON.parse(await gh(runListArguments(actor))),
      dispatchedAtMs,
    );
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
