import {
  diceScore,
  mixedNameScore,
  preferredNameScore,
  readingGate,
  readingNameScore,
} from "@public-phonebook/directory/forgiving-search-policy";
import fc from "fast-check";
import { expect, it } from "vitest";

it("matches independent integer division for every admitted preference score", () => {
  for (let score = 0; score <= 1_000_000; score += 1) {
    const reference = Number((BigInt(score) * 499_999n) / 1_000_000n);
    if (
      preferredNameScore(score, false) !== reference ||
      preferredNameScore(score, true) !== reference + 500_000
    )
      throw new Error(`Incorrect score division at ${score}`);
  }
});

it("preserves Dice and mixture bounds under independent integer arithmetic", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 25_600_000 }),
      fc.bigInt({ min: 0n, max: 100_000_000_000_000n }),
      (query, rawName) => {
        const name = Number(rawName);
        const shared = Math.min(query, name);
        const denominator = BigInt(query) + rawName;
        expect(diceScore(shared, query, name)).toBe(
          denominator ? Number((20_000n * BigInt(shared)) / denominator) : 0,
        );
      },
    ),
    { seed: 20261105, numRuns: 1000 },
  );
  expect(mixedNameScore(10_000, 10_000)).toBe(1_000_000);
  expect(readingNameScore(false, false, 10_000, 10_000)).toBe(800_000);
});

it("uses strict frozen tree boundaries and never selects a locked route", () => {
  expect(readingGate(1250, 501, false, false, true, false)).toBe(false);
  expect(readingGate(1251, 500, false, false, true, false)).toBe(false);
  expect(readingGate(1251, 501, false, false, true, false)).toBe(true);
  for (const alias of [true, false])
    for (const conservative of [true, false])
      expect(readingGate(4000, 1000, alias, conservative, true, true)).toBe(
        false,
      );
});
