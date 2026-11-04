import { describe, expect, it } from "vitest";
import {
  countWork,
  type OwnInstructions,
  recordProcess,
  StepTimer,
} from "../../tools/step-timing.ts";

const startMs = 1000;
const typecheckMs = 4210.4;
const proofMs = 1500;
const secondProofMs = 2500.6;
const failedMs = 300;
const untimedMs = 89;
const ownBefore = 1000;
const ownAfter = 1600;
const childInstructions = 4000;
const forkingInstructions = 70;
const generations = 44;

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

/** Returns a reader of the gate's own count that reports the given readings in order. */
function scriptedCounts(readings: readonly (number | null)[]): OwnInstructions {
  let index = 0;
  return async () => {
    const reading = readings[index];
    if (reading === undefined) throw new Error("The scripted counts ran out");
    index += 1;
    return reading;
  };
}

const steadyClock = (): number => startMs;
const unmeasured = {
  instructions: null,
  coverage: "unmeasured",
  gaps: [],
  work: {},
} as const;

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
      {
        step: "typecheck",
        runs: 1,
        ms: Math.round(typecheckMs),
        ...unmeasured,
      },
      {
        step: "proof",
        runs: 2,
        ms: Math.round(proofMs + secondProofMs),
        ...unmeasured,
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
    expect(timer.steps()).toEqual([
      { step: "lint", runs: 1, ms: failedMs, ...unmeasured },
    ]);
  });

  it("counts the gate's own work and every child process when nothing escapes the count", async () => {
    const timer = new StepTimer(
      steadyClock,
      scriptedCounts([ownBefore, ownAfter]),
    );
    await timer.time("models", async () => {
      recordProcess({
        command: "node",
        instructions: childInstructions,
        reapedDescendants: false,
      });
      countWork("model generations", generations);
    });
    expect(timer.steps()).toEqual([
      {
        step: "models",
        runs: 1,
        ms: 0,
        instructions: ownAfter - ownBefore + childInstructions,
        coverage: "complete",
        gaps: [],
        work: { processes: 1, "model generations": generations },
      },
    ]);
  });

  it("names the forked, delegated, and uncounted work that a partial step leaves out", async () => {
    const timer = new StepTimer(
      steadyClock,
      scriptedCounts([ownBefore, ownAfter]),
    );
    await timer.time("proof", async () => {
      recordProcess({
        command: "npm",
        instructions: forkingInstructions,
        reapedDescendants: true,
      });
      recordProcess({
        command: "docker",
        instructions: childInstructions,
        reapedDescendants: false,
        delegated: "the container VM",
      });
      recordProcess({
        command: "git",
        instructions: null,
        reapedDescendants: false,
      });
    });
    const [step] = timer.steps();
    expect(step?.instructions).toBe(
      ownAfter - ownBefore + forkingInstructions + childInstructions,
    );
    expect(step?.coverage).toBe("partial");
    expect(step?.gaps).toEqual([
      "docker: work in the container VM",
      "git: no count",
      "npm: forked processes",
    ]);
    expect(step?.work).toEqual({ processes: 3 });
  });

  it("reports no instruction count without a reading of the gate's own work, and none for a nested step", async () => {
    const timer = new StepTimer(
      steadyClock,
      scriptedCounts([ownBefore, null, ownBefore, ownAfter]),
    );
    await timer.time("audit", async () => {
      recordProcess({
        command: "npm",
        instructions: childInstructions,
        reapedDescendants: false,
      });
    });
    await timer.time("outer", () =>
      timer.time("inner", async () => countWork("checks", 1)),
    );
    const [audit, outer, inner] = timer.steps();
    expect(audit).toMatchObject({
      instructions: null,
      coverage: "unmeasured",
      gaps: [],
      work: { processes: 1 },
    });
    expect(outer).toMatchObject({
      instructions: ownAfter - ownBefore,
      coverage: "complete",
    });
    expect(inner).toMatchObject({
      instructions: null,
      coverage: "unmeasured",
      work: { checks: 1 },
    });
  });

  it("ignores process records and counters outside any step", () => {
    recordProcess({
      command: "cargo",
      instructions: childInstructions,
      reapedDescendants: false,
    });
    countWork("builds", 1);
    expect(new StepTimer(steadyClock).steps()).toEqual([]);
  });

  it("formats one row per step and the total in seconds and billions of instructions", async () => {
    const timer = new StepTimer(
      scriptedClock([
        startMs,
        startMs,
        startMs + typecheckMs,
        startMs + typecheckMs,
        startMs + typecheckMs,
        startMs + typecheckMs + untimedMs,
      ]),
      scriptedCounts([0, 2_500_000_000, 0, 1_000_000_000]),
    );
    await timer.time("typecheck", () => undefined);
    await timer.time("lint", () =>
      recordProcess({
        command: "npm",
        instructions: 0,
        reapedDescendants: true,
      }),
    );
    expect(timer.table("check").split("\n")).toEqual([
      "check step                runs   seconds Ginstructions",
      "typecheck                    1       4.2          2.50",
      "lint                         1       0.0         1.00+",
      "total                                4.3",
    ]);
  });
});
