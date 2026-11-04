import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const millisecondsPerSecond = 1000;
const instructionsPerBillion = 1e9;
const secondDecimals = 1;
const billionDecimals = 2;
const stepColumn = 24;
const runsColumn = 6;
const secondsColumn = 10;
const instructionsColumn = 14;

/**
 * `complete` counts every process of the step, including the gate's own work.
 * `partial` leaves out work that `gaps` names.
 * `unmeasured` had no instruction count at all, as on Linux.
 */
export type Coverage = "complete" | "partial" | "unmeasured";

/** One child process of a step, as the step meter counted it. */
export interface ProcessCount {
  readonly command: string;
  /** Retired instructions of the process and the programs it exec'd, or `null` without a count. */
  readonly instructions: number | null;
  /** The process reaped a process of its own, whose instructions the count omits. */
  readonly reapedDescendants: boolean;
  /** Where the process handed its work, outside every counted process. */
  readonly delegated?: string | undefined;
}

/** Reads the gate process's own retired instructions, or `null` where the system keeps no count. */
export type OwnInstructions = () => Promise<number | null>;

export interface StepDuration {
  readonly step: string;
  readonly runs: number;
  readonly ms: number;
  readonly instructions: number | null;
  readonly coverage: Coverage;
  readonly gaps: readonly string[];
  readonly work: Readonly<Record<string, number>>;
}

interface StepTotals {
  runs: number;
  elapsed: number;
  instructions: number;
  measured: boolean;
  readonly gaps: Set<string>;
  readonly work: Map<string, number>;
}

const activeStep = new AsyncLocalStorage<StepTotals>();

function addWork(step: StepTotals, name: string, amount: number): void {
  step.work.set(name, (step.work.get(name) ?? 0) + amount);
}

/** Adds a deterministic work counter to the step that is running, if any. */
export function countWork(name: string, amount: number): void {
  const step = activeStep.getStore();
  if (step) addWork(step, name, amount);
}

/** Adds one finished child process to the step that is running, if any. */
export function recordProcess(count: ProcessCount): void {
  const step = activeStep.getStore();
  if (!step) return;
  addWork(step, "processes", 1);
  if (count.instructions === null) step.gaps.add(`${count.command}: no count`);
  else step.instructions += count.instructions;
  if (count.reapedDescendants)
    step.gaps.add(`${count.command}: forked processes`);
  if (count.delegated)
    step.gaps.add(`${count.command}: work in ${count.delegated}`);
}

/** Adds up the wall time, retired instructions, and work counters of each named step for the gate's report; no verdict reads them. */
export class StepTimer {
  readonly #clock: () => number;
  readonly #own: OwnInstructions;
  readonly #started: number;
  readonly #steps = new Map<string, StepTotals>();

  constructor(
    clock: () => number = (): number => performance.now(),
    own: OwnInstructions = async (): Promise<null> => null,
  ) {
    this.#clock = clock;
    this.#own = own;
    this.#started = clock();
  }

  /** Runs `action` and adds its wall time, instructions, and work to `step`, whether it returns or throws. */
  async time<T>(step: string, action: () => Promise<T> | T): Promise<T> {
    const totals = this.#steps.get(step) ?? {
      runs: 0,
      elapsed: 0,
      instructions: 0,
      measured: true,
      gaps: new Set<string>(),
      work: new Map<string, number>(),
    };
    this.#steps.set(step, totals);
    const nested = activeStep.getStore() !== undefined;
    const before = nested ? null : await this.#own();
    const started = this.#clock();
    try {
      return await activeStep.run(totals, action);
    } finally {
      totals.runs += 1;
      totals.elapsed += this.#clock() - started;
      const after = before === null ? null : await this.#own();
      if (before === null || after === null) totals.measured = false;
      else totals.instructions += after - before;
      if (nested) totals.gaps.add("ran inside another step");
    }
  }

  /** Lists each step once, in the order of its first run, with whole milliseconds. */
  steps(): readonly StepDuration[] {
    return [...this.#steps].map(([step, totals]) => ({
      step,
      runs: totals.runs,
      ms: Math.round(totals.elapsed),
      instructions: totals.measured ? totals.instructions : null,
      coverage: !totals.measured
        ? "unmeasured"
        : totals.gaps.size === 0
          ? "complete"
          : "partial",
      gaps: totals.measured ? [...totals.gaps].sort() : [],
      work: Object.fromEntries(totals.work),
    }));
  }

  /** Measures the wall time since the timer started, including untimed work between steps. */
  totalMs(): number {
    return Math.round(this.#clock() - this.#started);
  }

  /** Formats the steps and the total as a table for standard error. */
  table(gate: string): string {
    const seconds = (ms: number): string =>
      (ms / millisecondsPerSecond)
        .toFixed(secondDecimals)
        .padStart(secondsColumn);
    const billions = (step: StepDuration): string =>
      (step.instructions === null
        ? "-"
        : `${(step.instructions / instructionsPerBillion).toFixed(billionDecimals)}${step.coverage === "complete" ? "" : "+"}`
      ).padStart(instructionsColumn);
    return [
      `${`${gate} step`.padEnd(stepColumn)}${"runs".padStart(runsColumn)}${"seconds".padStart(secondsColumn)}${"Ginstructions".padStart(instructionsColumn)}`,
      ...this.steps().map(
        (step) =>
          `${step.step.padEnd(stepColumn)}${String(step.runs).padStart(runsColumn)}${seconds(step.ms)}${billions(step)}`,
      ),
      `${"total".padEnd(stepColumn)}${"".padStart(runsColumn)}${seconds(this.totalMs())}`,
    ].join("\n");
  }
}
