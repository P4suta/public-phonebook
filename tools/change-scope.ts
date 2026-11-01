import { appendFile } from "node:fs/promises";
import { command } from "./process.ts";

export type AssuranceJob = "proofs" | "ios";
export type AssuranceSelection = Readonly<Record<AssuranceJob, boolean>>;

const gateDefinition = [
  ".github/workflows/checks.yml",
  ".github/actions/toolchain/",
  "mise.toml",
  "justfile",
];
const leanProofInputs = [
  "verification/ios/",
  "tools/ios-check/",
  "ios/Sources/PhonebookCore/ReceiveBudget.swift",
  "ios/Tests/PhonebookCoreTests/PublicationContract.json",
];

export const assuranceInputs: Readonly<
  Record<AssuranceJob, readonly string[]>
> = {
  proofs: [
    ...gateDefinition,
    "proof/",
    "lemmascript.json",
    "package.json",
    "package-lock.json",
    "tools/prove.ts",
    "src/core/*-policy.ts",
    ...leanProofInputs,
  ],
  ios: [
    ...gateDefinition,
    "ios/",
    "tools/ios-check/",
    "tools/native-fixture.ts",
    "tools/directory-fixture.ts",
    "src/core/api-contract.ts",
    "src/core/directory-archive.ts",
    "src/core/models.ts",
  ],
};

const commitShaLength = 40;
const commitSha = new RegExp(`^[0-9a-f]{${commitShaLength}}$`, "u");

export function matchesInput(path: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  const wildcard = pattern.indexOf("*");
  if (wildcard < 0) return path === pattern;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  return (
    path.length >= prefix.length + suffix.length &&
    path.startsWith(prefix) &&
    path.endsWith(suffix) &&
    !path.slice(prefix.length, path.length - suffix.length).includes("/")
  );
}

export function selectAssurance(
  assurance: boolean,
  changed: readonly string[] | undefined,
): AssuranceSelection {
  const affected = (job: AssuranceJob): boolean =>
    assurance ||
    (changed ?? []).some((path) =>
      assuranceInputs[job].some((pattern) => matchesInput(path, pattern)),
    );
  return { proofs: affected("proofs"), ios: affected("ios") };
}

async function changedPaths(base: string): Promise<readonly string[]> {
  if (!commitSha.test(base))
    throw new Error("The change base must be a full commit SHA");
  const diff = await command(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", base, "HEAD"],
    true,
  );
  if (diff.code !== 0)
    throw new Error(`Could not list changed paths: ${diff.stderr}`);
  return diff.stdout.split("\0").filter(Boolean);
}

if (import.meta.main) {
  const changed =
    process.env.CHANGE_EVENT === "workflow_dispatch"
      ? undefined
      : await changedPaths(process.env.CHANGE_BASE ?? "");
  const selection = selectAssurance(process.env.ASSURANCE === "true", changed);
  const output = process.env.GITHUB_OUTPUT;
  if (output)
    await appendFile(
      output,
      `proofs=${String(selection.proofs)}\nios=${String(selection.ios)}\n`,
    );
  console.info(
    JSON.stringify({
      operation: "change-scope",
      changed: changed?.length ?? null,
      ...selection,
    }),
  );
}
