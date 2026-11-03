import { performance } from "node:perf_hooks";

const millisecondsPerSecond = 1000;
const secondDecimals = 1;
const stepColumn = 24;
const runsColumn = 6;
const secondsColumn = 10;

export interface StepDuration {
  readonly step: string;
  readonly runs: number;
  readonly ms: number;
}

/** Adds up the wall time of each named step for the gate's report; no verdict reads it. */
export class StepTimer {
  readonly #clock: () => number;
  readonly #started: number;
  readonly #steps = new Map<string, { runs: number; elapsed: number }>();

  constructor(clock: () => number = (): number => performance.now()) {
    this.#clock = clock;
    this.#started = clock();
  }

  /** Runs `action` and adds its wall time to `step`, whether it returns or throws. */
  async time<T>(step: string, action: () => Promise<T> | T): Promise<T> {
    const started = this.#clock();
    try {
      return await action();
    } finally {
      const recorded = this.#steps.get(step) ?? { runs: 0, elapsed: 0 };
      this.#steps.set(step, {
        runs: recorded.runs + 1,
        elapsed: recorded.elapsed + this.#clock() - started,
      });
    }
  }

  /** Lists each step once, in the order of its first run, with whole milliseconds. */
  steps(): readonly StepDuration[] {
    return [...this.#steps].map(([step, { runs, elapsed }]) => ({
      step,
      runs,
      ms: Math.round(elapsed),
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
    return [
      `${`${gate} step`.padEnd(stepColumn)}${"runs".padStart(runsColumn)}${"seconds".padStart(secondsColumn)}`,
      ...this.steps().map(
        ({ step, runs, ms }) =>
          `${step.padEnd(stepColumn)}${String(runs).padStart(runsColumn)}${seconds(ms)}`,
      ),
      `${"total".padEnd(stepColumn)}${"".padStart(runsColumn)}${seconds(this.totalMs())}`,
    ].join("\n");
  }
}
