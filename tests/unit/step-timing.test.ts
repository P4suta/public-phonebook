import { describe, expect, it } from "vitest";
import { StepTimer } from "../../tools/step-timing.ts";

const startMs = 1000;
const typecheckMs = 4210.4;
const proofMs = 1500;
const secondProofMs = 2500.6;
const failedMs = 300;
const untimedMs = 89;

/** Returns a clock that reports the given readings in order. */
function scriptedClock(readings: readonly number[]): () => number {
  let index = 0;
  return () => {
    const reading = readings[index];
    if (reading === undefined) throw new Error("The scripted clock ran out");
    index += 1;
    return reading;
  };
}

describe("step timing", () => {
  it("adds repeated steps, keeps first-run order, and rounds to whole milliseconds", async () => {
    const afterTypecheck = startMs + typecheckMs;
    const afterProof = afterTypecheck + proofMs;
    const afterSecondProof = afterProof + secondProofMs;
    const timer = new StepTimer(
      scriptedClock([
        startMs,
        startMs,
        afterTypecheck,
        afterTypecheck,
        afterProof,
        afterProof,
        afterSecondProof,
        afterSecondProof + untimedMs,
      ]),
    );
    expect(await timer.time("typecheck", () => "typed")).toBe("typed");
    await timer.time("proof", async () => undefined);
    await timer.time("proof", async () => undefined);
    expect(timer.steps()).toEqual([
      { step: "typecheck", runs: 1, ms: Math.round(typecheckMs) },
      {
        step: "proof",
        runs: 2,
        ms: Math.round(proofMs + secondProofMs),
      },
    ]);
    expect(timer.totalMs()).toBe(
      Math.round(typecheckMs + proofMs + secondProofMs + untimedMs),
    );
  });

  it("records a failed step and passes its error through unchanged", async () => {
    const failure = new Error("lint failed");
    const timer = new StepTimer(
      scriptedClock([startMs, startMs, startMs + failedMs]),
    );
    await expect(
      timer.time("lint", () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(timer.steps()).toEqual([{ step: "lint", runs: 1, ms: failedMs }]);
  });

  it("formats one row per step and the total in seconds", async () => {
    const timer = new StepTimer(
      scriptedClock([
        startMs,
        startMs,
        startMs + typecheckMs,
        startMs + typecheckMs + untimedMs,
      ]),
    );
    await timer.time("typecheck", () => undefined);
    expect(timer.table("check").split("\n")).toEqual([
      "check step                runs   seconds",
      "typecheck                    1       4.2",
      "total                                4.3",
    ]);
  });
});
