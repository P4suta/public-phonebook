import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { releasePreflight } from "../../src/core/publication-policy.ts";
import {
  missingStages,
  type PreflightFacts,
  parseReleaseArguments,
  preflightPlan,
  stageCommands,
} from "../../tools/release.ts";
import {
  type CandidateEvidence,
  type CandidateStage,
  candidateSigner,
  candidateStages,
  type ExpectedStage,
} from "../../tools/release-store.ts";
import { perStage, stageInputs } from "../../tools/stage-inputs.ts";

const dataset = "a".repeat(64);
const otherDataset = "b".repeat(64);
const head = "c".repeat(40);
const ready: PreflightFacts = {
  clean: true,
  head,
  releaseHead: head,
  bundleManifest: dataset,
  dataset,
  missing: [],
};

function inputs(stage: CandidateStage): string {
  return (candidateStages.indexOf(stage) + 1).toString(16).padStart(64, "0");
}

const expected = perStage(
  (stage): ExpectedStage => ({
    inputsSha256: inputs(stage),
    manifestSha256: stageInputs[stage].dataset ? dataset : null,
  }),
);

function receipt(
  stage: CandidateStage,
  change: Partial<CandidateEvidence> = {},
): CandidateEvidence {
  return {
    formatVersion: 2,
    stage,
    inputsSha256: inputs(stage),
    manifestSha256: expected[stage].manifestSha256,
    sourceTree: head,
    result: "passed",
    provenance: { kind: "local" },
    ...change,
  };
}

const allReceipts = perStage((stage) => receipt(stage));

describe("release preflight", () => {
  it("refuses a checkout with uncommitted changes before anything else", () => {
    expect(
      preflightPlan({
        ...ready,
        clean: false,
        head: "d".repeat(40),
        missing: candidateStages,
      }),
    ).toEqual({ action: "refuse", reason: "dirty-tree" });
  });
  it("refuses a checkout whose commit differs from the release branch head", () => {
    expect(preflightPlan({ ...ready, releaseHead: "d".repeat(40) })).toEqual({
      action: "refuse",
      reason: "not-release-head",
    });
  });
  it("refuses a bundle that holds another dataset or none", () => {
    for (const bundleManifest of [otherDataset, ""])
      expect(preflightPlan({ ...ready, bundleManifest })).toEqual({
        action: "refuse",
        reason: "different-dataset",
      });
  });
  it("dispatches without running a stage when every stage has a local pass", () => {
    expect(missingStages(expected, allReceipts)).toEqual([]);
    expect(preflightPlan(ready)).toEqual({ action: "dispatch" });
  });
  it("runs exactly the stages whose local receipt is absent, stale, failed, for another dataset, or from another signer", () => {
    const receipts: Partial<Record<CandidateStage, CandidateEvidence>> = {
      ...allReceipts,
      check: receipt("check", { inputsSha256: "e".repeat(64) }),
      parity: receipt("parity", { manifestSha256: otherDataset }),
      prove: receipt("prove", { result: "failed" }),
      "ios-check": receipt("ios-check", {
        provenance: {
          kind: "github-actions",
          repository: "P4suta/public-phonebook",
          workflow: candidateSigner,
          runId: "1",
          runAttempt: 1,
          commit: head,
          actor: "owner",
        },
      }),
    };
    delete receipts.e2e;
    const missing = missingStages(expected, receipts);
    expect(missing).toEqual(["check", "parity", "prove", "e2e", "ios-check"]);
    expect(preflightPlan({ ...ready, missing })).toEqual({
      action: "run",
      stages: missing,
    });
  });
  it("seeds and builds before the stages that compare the server with the bundle", () => {
    expect(stageCommands("/bundle", ["check", "prove"])).toEqual([
      [
        "node",
        [
          "tools/test.ts",
          "--bundle",
          "/bundle",
          "--stage",
          "check",
          "--stage",
          "prove",
        ],
      ],
    ]);
    expect(stageCommands("/bundle", ["e2e"])).toEqual([
      ["node", ["tools/local-data.ts", "/bundle"]],
      ["npm", ["run", "build"]],
      ["node", ["tools/test.ts", "--bundle", "/bundle", "--stage", "e2e"]],
    ]);
  });
  it("matches the proved decision on every combination of its conditions", () => {
    for (const clean of [false, true])
      for (const releaseHead of [head, "d".repeat(40)])
        for (const bundleManifest of [dataset, otherDataset])
          for (const missing of [0, 1, candidateStages.length]) {
            const decision = releasePreflight(
              clean,
              head,
              releaseHead,
              bundleManifest,
              dataset,
              missing,
            );
            const admitted =
              clean && releaseHead === head && bundleManifest === dataset;
            expect(decision).toBe(
              !clean
                ? "dirty-tree"
                : releaseHead !== head
                  ? "not-release-head"
                  : bundleManifest !== dataset
                    ? "different-dataset"
                    : missing > 0
                      ? "run-stages"
                      : "dispatch",
            );
            expect(decision === "dispatch").toBe(admitted && missing === 0);
          }
  });
  it("reads the dataset and an optional bundle directory", () => {
    expect(parseReleaseArguments([dataset])).toEqual({
      dataset,
      bundle: resolve(".local/datasets", dataset),
    });
    expect(parseReleaseArguments([dataset, "--bundle", "target/x"])).toEqual({
      dataset,
      bundle: resolve("target/x"),
    });
    for (const args of [
      [],
      [dataset, "--bundle"],
      [dataset, "--other", "x"],
      [dataset, "--bundle", "x", "extra"],
    ])
      expect(() => parseReleaseArguments(args)).toThrow("Usage: release");
    expect(() => parseReleaseArguments(["not-a-digest"])).toThrow();
  });
});
