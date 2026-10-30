import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as v from "valibot";
import { prepareCheckFixture } from "./check-fixture.ts";
import { command, requireCommand } from "./process.ts";

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
  await requireCommand("gitleaks", [
    "dir",
    "--no-banner",
    "--redact",
    destination,
  ]);
  console.info(JSON.stringify({ operation: "secrets", files }));
}

for (const script of ["typecheck", "lint", "test", "build", "audit"])
  await requireCommand("npm", ["run", script]);
const decoded: unknown = JSON.parse(
  await readFile("test-results/unit.json", "utf8"),
);
const results = v.parse(
  v.object({ numPassedTests: v.number(), numFailedTests: v.literal(0) }),
  decoded,
);
if (results.numPassedTests < minimumBehavioralTests)
  throw new Error("The behavioral test inventory is incomplete");
await scanSecrets();
await requireCommand("actionlint", [".github/workflows/checks.yml"]);
await prepareCheckFixture();
await requireCommand("npm", [
  "exec",
  "--no",
  "--",
  "playwright",
  "test",
  "--config=playwright.check.config.ts",
]);
console.info(
  JSON.stringify({
    operation: "check",
    unitTests: results.numPassedTests,
    result: "passed",
  }),
);
