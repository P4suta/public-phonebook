import { createHash } from "node:crypto";
import * as v from "valibot";
import { DigestSchema } from "../src/core/models.ts";
import { command } from "./process.ts";
import type { CandidateStage, ExpectedStage } from "./release-store.ts";

const inputsFormat = 1;
const candidateWorkflow = ".github/workflows/candidate.yml";

/**
 * The files that `tools/ios-check` hashes for its own receipts.
 * A unit test requires this list to match `SCOPE` in `tools/ios-check/src/ios.rs`.
 */
export const iosCheckScope = [
  "tests/fixtures/search-ranking.json",
  "ios",
  "verification/ios",
  "src/core",
  "src/server",
  "tools",
  "mise.toml",
  "justfile",
  ".github/workflows/checks.yml",
  ".github/workflows/ios.yml",
  ".github/actions/toolchain",
  ".github/actionlint.yaml",
  ".gitignore",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "biome.json",
  "design",
  "public",
  "src/ui/icons.tsx",
] as const;

/** Paths that only the native app and its checks read. */
const nativeOnly = [
  "ios",
  "verification/ios",
  "tools/ios-check",
  "android",
  "verification/android",
  "tools/android-check",
] as const;

export interface StageInputs {
  /** Path prefixes of the tracked files the stage reads, or `tree` for every tracked file. */
  readonly include: readonly string[] | "tree";
  readonly exclude: readonly string[];
  readonly dataset: boolean;
}

/**
 * The files whose bytes can change each stage's verdict.
 * A stage that lists prefixes reads nothing outside them, and an exclusion names only paths the stage never reads.
 */
export const stageInputs: Readonly<Record<CandidateStage, StageInputs>> = {
  check: { include: "tree", exclude: [], dataset: false },
  prove: { include: "tree", exclude: [], dataset: false },
  data: { include: "tree", exclude: nativeOnly, dataset: true },
  phones: { include: "tree", exclude: nativeOnly, dataset: true },
  parity: { include: "tree", exclude: nativeOnly, dataset: true },
  e2e: { include: "tree", exclude: nativeOnly, dataset: true },
  "ios-prove": {
    include: [...iosCheckScope, candidateWorkflow],
    exclude: [],
    dataset: false,
  },
  "ios-check": {
    include: [...iosCheckScope, candidateWorkflow],
    exclude: [],
    dataset: false,
  },
};

export interface TrackedFile {
  readonly mode: string;
  readonly object: string;
  readonly path: string;
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function stageReads(inputs: StageInputs, path: string): boolean {
  const included =
    inputs.include === "tree" ||
    inputs.include.some((prefix) => under(path, prefix));
  return included && !inputs.exclude.some((prefix) => under(path, prefix));
}

/** Digests the stage's declaration, the exact bytes of every file it reads, and the dataset when it reads one. */
export function stageInputDigest(
  stage: CandidateStage,
  files: readonly TrackedFile[],
  manifestSha256: string | null,
): string {
  const inputs = stageInputs[stage];
  if (inputs.dataset && manifestSha256 === null)
    throw new Error(`The ${stage} stage reads a dataset`);
  const selected = files
    .filter((file) => stageReads(inputs, file.path))
    .map((file) => `${file.mode} ${file.object} ${file.path}`)
    .sort();
  if (!selected.length)
    throw new Error(`The ${stage} stage reads no tracked file`);
  return createHash("sha256")
    .update(
      JSON.stringify({
        formatVersion: inputsFormat,
        stage,
        include: inputs.include,
        exclude: inputs.exclude,
        manifestSha256: inputs.dataset
          ? v.parse(DigestSchema, manifestSha256)
          : null,
        files: selected,
      }),
    )
    .digest("hex");
}

export type StageExpectations = Readonly<Record<CandidateStage, ExpectedStage>>;

/** Builds a value for every candidate stage, so adding a stage fails to compile until it has one. */
export function perStage<T>(
  value: (stage: CandidateStage) => T,
): Readonly<Record<CandidateStage, T>> {
  return {
    check: value("check"),
    data: value("data"),
    parity: value("parity"),
    phones: value("phones"),
    prove: value("prove"),
    e2e: value("e2e"),
    "ios-prove": value("ios-prove"),
    "ios-check": value("ios-check"),
  };
}

export function stageExpectations(
  files: readonly TrackedFile[],
  manifestSha256: string,
): StageExpectations {
  return perStage((stage) => {
    const manifest = stageInputs[stage].dataset ? manifestSha256 : null;
    return {
      inputsSha256: stageInputDigest(stage, files, manifest),
      manifestSha256: manifest,
    };
  });
}

const TrackedLineSchema = v.pipe(
  v.string(),
  v.regex(/^(?<mode>[0-7]{6}) (?<type>blob|commit) (?<object>[a-f0-9]{40})\t/u),
);

/** Lists the committed files of a clean checkout with their Git object IDs. */
export async function trackedFiles(): Promise<readonly TrackedFile[]> {
  const status = await command("git", ["status", "--porcelain"], true);
  if (status.code !== 0 || status.stdout.trim())
    throw new Error("Stage inputs require a clean committed source tree");
  const listing = await command(
    "git",
    ["ls-tree", "-r", "-z", "--full-tree", "HEAD"],
    true,
  );
  if (listing.code !== 0) throw new Error("Cannot list the source tree");
  return listing.stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      v.parse(TrackedLineSchema, entry);
      const [metadata = "", path = ""] = entry.split("\t");
      const [mode = "", , object = ""] = metadata.split(" ");
      return { mode, object, path };
    });
}
