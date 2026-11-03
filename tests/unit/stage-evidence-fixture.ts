import { createHash } from "node:crypto";
import type {
  CandidateEvidence,
  CandidateStage,
  ExpectedStage,
  RunProvenance,
} from "../../tools/release-store.ts";
import {
  perStage,
  type StageExpectations,
  stageInputs,
} from "../../tools/stage-inputs.ts";

/** Gives each stage a distinct inputs digest for a named source state, and the dataset only where the stage reads one. */
export function expectedStages(
  source: string,
  manifestSha256: string,
): StageExpectations {
  return perStage((stage) => {
    const manifest = stageInputs[stage].dataset ? manifestSha256 : null;
    return {
      inputsSha256: createHash("sha256")
        .update(`${source}/${stage}/${manifest ?? ""}`)
        .digest("hex"),
      manifestSha256: manifest,
    };
  });
}

export function passingEvidence(
  stage: CandidateStage,
  expected: ExpectedStage,
  provenance: RunProvenance,
  sourceTree = "d".repeat(40),
): CandidateEvidence {
  return {
    formatVersion: 2,
    stage,
    inputsSha256: expected.inputsSha256,
    manifestSha256: expected.manifestSha256,
    sourceTree,
    result: "passed",
    provenance,
  };
}
