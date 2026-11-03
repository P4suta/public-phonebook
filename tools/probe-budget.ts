import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";
import * as v from "valibot";
import { probeHold } from "../src/core/publication-policy.ts";

export const probeWindowMs = 10_000;
export const probeLimit = 40;
const ledgerRetries = 200;
const ledgerRetryMinMs = 5;
const ledgerRetryMaxMs = 50;
const ledgerStaleMs = 10_000;

export interface ProbeAdmission {
  readonly admitted: boolean;
  readonly recent: readonly number[];
  readonly waitMs: number;
}

export function probeAdmission(
  sent: readonly number[],
  now: number,
): ProbeAdmission {
  const recent = sent.filter((time) => time > now - probeWindowMs);
  if (recent.length + 1 < probeLimit)
    return { admitted: true, recent: [...recent, now], waitMs: 0 };
  // A time from a faster clock counts against the window but can't hold a request past it.
  return {
    admitted: false,
    recent,
    waitMs: probeHold(Math.min(...recent, now), now, probeWindowMs),
  };
}

export interface ProbeClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}
export const systemClock: ProbeClock = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export interface ProbeBudget {
  take(): Promise<void>;
}

/** Waits out a refusal and logs it, so a slow check shows whether the budget held its requests. */
async function holdFor(clock: ProbeClock, waitMs: number): Promise<void> {
  console.info(JSON.stringify({ operation: "probe.hold", waitMs }));
  await clock.sleep(waitMs);
}

export function memoryBudget(clock: ProbeClock = systemClock): ProbeBudget {
  let sent: readonly number[] = [];
  return {
    async take(): Promise<void> {
      for (;;) {
        const admission = probeAdmission(sent, clock.now());
        sent = admission.recent;
        if (admission.admitted) return;
        await holdFor(clock, admission.waitMs);
      }
    },
  };
}

const LedgerSchema = v.array(v.pipe(v.number(), v.integer()));

async function readLedger(path: string): Promise<readonly number[]> {
  try {
    return v.parse(LedgerSchema, JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

export function ledgerBudget(
  path: string,
  clock: ProbeClock = systemClock,
): ProbeBudget {
  return {
    async take(): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      for (;;) {
        const unlock = await lock(path, {
          realpath: false,
          stale: ledgerStaleMs,
          retries: {
            retries: ledgerRetries,
            minTimeout: ledgerRetryMinMs,
            maxTimeout: ledgerRetryMaxMs,
          },
        });
        let admission: ProbeAdmission;
        try {
          admission = probeAdmission(await readLedger(path), clock.now());
          await writeFile(path, JSON.stringify(admission.recent));
        } finally {
          await unlock();
        }
        if (admission.admitted) return;
        await holdFor(clock, admission.waitMs);
      }
    },
  };
}
