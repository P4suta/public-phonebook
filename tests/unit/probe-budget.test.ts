import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ledgerBudget,
  memoryBudget,
  type ProbeClock,
  probeAdmission,
  probeLimit,
  probeWindowMs,
} from "../../tools/probe-budget.ts";

function fakeClock(): ProbeClock & { readonly slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    async sleep(milliseconds): Promise<void> {
      slept.push(milliseconds);
      now += milliseconds;
    },
  };
}

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "phonebook-probes-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("probe budget", () => {
  it("admits a 39th request in a 10-second window and holds the one that would be the 40th", () => {
    const sent = Array.from({ length: probeLimit - 2 }, (_, index) => index);
    const admitted = probeAdmission(sent, probeLimit);
    expect(admitted.admitted).toBe(true);
    expect(admitted.recent).toHaveLength(probeLimit - 1);
    const refused = probeAdmission(admitted.recent, probeLimit);
    expect(refused).toEqual({
      admitted: false,
      recent: admitted.recent,
      waitMs: probeWindowMs - probeLimit,
    });
    expect(probeAdmission(admitted.recent, probeWindowMs).admitted).toBe(true);
  });

  it("never holds a request longer than one window, even after a time from a faster clock", () => {
    const future = probeWindowMs * 3;
    const sent = [
      ...Array.from({ length: probeLimit - 2 }, (_, index) => index),
      future,
    ];
    const refused = probeAdmission(sent, probeLimit);
    expect(refused.admitted).toBe(false);
    expect(refused.waitMs).toBeGreaterThan(0);
    expect(refused.waitMs).toBeLessThanOrEqual(probeWindowMs);
    const ahead = probeAdmission(
      Array.from({ length: probeLimit - 1 }, () => future),
      0,
    );
    expect(ahead).toMatchObject({ admitted: false, waitMs: probeWindowMs });
  });

  it("holds requests until the window clears instead of sending a 40th", async () => {
    const clock = fakeClock();
    const budget = memoryBudget(clock);
    const sentAt: number[] = [];
    for (let index = 0; index < probeLimit * 2 + 1; index += 1) {
      await budget.take();
      sentAt.push(clock.now());
    }
    for (const time of sentAt)
      expect(
        sentAt.filter((other) => other <= time && other > time - probeWindowMs)
          .length,
      ).toBeLessThan(probeLimit);
    expect(clock.slept).toEqual([probeWindowMs, probeWindowMs]);
  });

  it("shares one window across budgets that use the same ledger", async () => {
    const clock = fakeClock();
    const path = join(directory, "ledger.json");
    const first = ledgerBudget(path, clock);
    const second = ledgerBudget(path, clock);
    for (let index = 0; index < probeLimit - 1; index += 1)
      await (index % 2 ? first : second).take();
    expect(clock.slept).toEqual([]);
    await first.take();
    expect(clock.slept).toEqual([probeWindowMs]);
  });

  it("logs one line with the wait for each held request", async () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const log = vi.spyOn(console, "info").mockImplementation((line) => {
      lines.push(String(line));
    });
    try {
      const budget = memoryBudget(clock);
      for (let index = 0; index < probeLimit; index += 1) await budget.take();
    } finally {
      log.mockRestore();
    }
    expect(lines.map((line): unknown => JSON.parse(line))).toEqual([
      { operation: "probe.hold", waitMs: probeWindowMs },
    ]);
  });
});
