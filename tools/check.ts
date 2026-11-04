import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as v from "valibot";
import {
  command,
  ownInstructions,
  prepareMeter,
  requireCommand,
  useMeter,
} from "./process.ts";
import { countWork, StepTimer } from "./step-timing.ts";
import { requireWorkflowPolicy } from "./workflow-policy.ts";

const minimumScanFiles = 20;
const minimumBehavioralTests = 20;

async function scanSecrets(): Promise<void> {
  const listing = await command(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    true,
  );
  if (listing.code !== 0)
    throw new Error("Could not inventory publishable files");
  const destination = resolve(".local/secret-scan");
  await rm(destination, { recursive: true, force: true });
  let files = 0;
  for (const file of new Set(listing.output.split("\0").filter(Boolean))) {
    const target = resolve(destination, file);
    if (!target.startsWith(`${destination}/`))
      throw new Error("Unsafe source path");
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file, target);
      files += 1;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
  if (files < minimumScanFiles)
    throw new Error("The secret scan inventory is incomplete");
  countWork("scanned files", files);
  await requireCommand("gitleaks", [
    "dir",
    "--no-banner",
    "--redact",
    "--config",
    "tools/gitleaks.toml",
    destination,
  ]);
  console.info(JSON.stringify({ operation: "secrets", files }));
}

const timer = new StepTimer(undefined, ownInstructions);
try {
  useMeter(await prepareMeter());
  for (const [step, script] of [
    ["typecheck", "typecheck"],
    ["lint", "lint"],
  ] as const)
    await timer.time(step, () => requireCommand("npm", ["run", script]));
  const results = await timer.time("unit tests", async () => {
    await requireCommand("npm", ["run", "test"]);
    const decoded: unknown = JSON.parse(
      await readFile("test-results/unit.json", "utf8"),
    );
    const parsed = v.parse(
      v.object({
        numPassedTests: v.number(),
        numFailedTests: v.literal(0),
        testResults: v.array(v.unknown()),
      }),
      decoded,
    );
    countWork("test files", parsed.testResults.length);
    countWork("tests", parsed.numPassedTests);
    return parsed;
  });
  await timer.time("audit", () => requireCommand("npm", ["run", "audit"]));
  if (results.numPassedTests < minimumBehavioralTests)
    throw new Error("The behavioral test inventory is incomplete");
  await timer.time("secrets", scanSecrets);
  await timer.time("actionlint", () => requireCommand("actionlint", []));
  await timer.time("zizmor", () =>
    requireCommand("zizmor", [
      "--offline",
      "--persona=pedantic",
      "--strict-collection",
      ".github",
    ]),
  );
  await timer.time("workflow policy", () => requireWorkflowPolicy("."));
  console.info(
    JSON.stringify({
      operation: "check",
      unitTests: results.numPassedTests,
      result: "passed",
      totalMs: timer.totalMs(),
      steps: timer.steps(),
    }),
  );
} finally {
  console.error(timer.table("check"));
}
