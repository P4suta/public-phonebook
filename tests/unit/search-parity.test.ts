import { describe, expect, it } from "vitest";
import { normalizePhone } from "../../src/core/phone.ts";
import { decodeSearchIndex } from "../../src/core/search-index.ts";
import {
  type ComparedResults,
  compareResults,
  isPortExhaustion,
  numberSpellings,
  type PortRetry,
  parityQueries,
  reorderPreviews,
  retryingDatabase,
  retryPortExhaustion,
  seededRandom,
  swapSameNameRows,
} from "../../tools/search-parity.ts";

function exhausted(): Error {
  return new TypeError("fetch failed", {
    cause: Object.assign(
      new Error("connect EADDRNOTAVAIL 127.0.0.1:53725 - Local (0.0.0.0:0)"),
      { code: "EADDRNOTAVAIL" },
    ),
  });
}

function recordedRetry(attempts = 3): PortRetry & { readonly waits: number[] } {
  const waits: number[] = [];
  return {
    attempts,
    waitMs: 7,
    waits,
    sleep: async (milliseconds): Promise<void> => {
      waits.push(milliseconds);
    },
  };
}

describe("port exhaustion retry", () => {
  it("recognizes EADDRNOTAVAIL in an error's cause chain and nothing else", () => {
    expect(isPortExhaustion(exhausted())).toBe(true);
    expect(isPortExhaustion(new Error("connect ECONNREFUSED"))).toBe(false);
    expect(isPortExhaustion("EADDRNOTAVAIL")).toBe(false);
  });

  it("repeats a read after port exhaustion until it succeeds", async () => {
    const retry = recordedRetry();
    let calls = 0;
    const value = await retryPortExhaustion(async () => {
      calls += 1;
      if (calls < 3) throw exhausted();
      return "rows";
    }, retry);
    expect(value).toBe("rows");
    expect(calls).toBe(3);
    expect(retry.waits).toEqual([7, 7]);
  });

  it("lets any other error through without a retry", async () => {
    const retry = recordedRetry();
    let calls = 0;
    await expect(
      retryPortExhaustion(async () => {
        calls += 1;
        throw new Error("no such table: contacts");
      }, retry),
    ).rejects.toThrow("no such table");
    expect(calls).toBe(1);
    expect(retry.waits).toEqual([]);
  });

  it("gives up after the configured attempts", async () => {
    const retry = recordedRetry(2);
    let calls = 0;
    await expect(
      retryPortExhaustion(async () => {
        calls += 1;
        throw exhausted();
      }, retry),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(2);
  });

  it("wraps prepared, bound, and batched reads of a D1 binding", async () => {
    const retry = recordedRetry();
    let reads = 0;
    let batches = 0;
    interface FakeStatement {
      readonly bind: (...values: unknown[]) => FakeStatement;
      readonly all: () => Promise<{ results: string[] }>;
    }
    const statement: FakeStatement = {
      bind: (): FakeStatement => statement,
      all: async (): Promise<{ results: string[] }> => {
        reads += 1;
        if (reads === 1) throw exhausted();
        return { results: ["row"] };
      },
    };
    const database = retryingDatabase(
      {
        prepare: (_sql: string) => statement,
        batch: async (statements: readonly unknown[]): Promise<number> => {
          batches += 1;
          if (batches === 1) throw exhausted();
          return statements.length;
        },
        dump: () => "dump",
      },
      retry,
    );
    await expect(database.prepare("SELECT 1").bind(1).all()).resolves.toEqual({
      results: ["row"],
    });
    await expect(database.batch([1, 2])).resolves.toBe(2);
    expect(database.dump()).toBe("dump");
    expect(retry.waits).toEqual([7, 7]);
  });
});

import { type ModelContact, modelDirectory } from "./local-search-fixture.ts";

const snapshot = "f".repeat(64);
const contacts: ModelContact[] = [
  ["c:1", "市立図書館", "library", "+81335812331"],
  ["c:2", "市立図書館", "medical", "+81335812332"],
  ["c:3", "県立図書館", "library", "+81774981200"],
  ["c:4", "図書館", "library", "+819012345678"],
].map(([id = "", name = "", category = "", e164 = ""]) => ({
  id,
  name,
  category,
  prefectureCode: "13",
  municipalityCode: "13101",
  phones: [{ e164 }],
}));
const index = decodeSearchIndex(modelDirectory(contacts, snapshot).bytes);
const counts = {
  substrings: 40,
  names: 20,
  numbers: 20,
  absent: 10,
  places: 20,
} as const;

const results: ComparedResults = {
  total: 3,
  groups: [
    {
      category: "library",
      total: 2,
      rows: [
        {
          id: "c:4",
          name: "図書館",
          category: "library",
          region: "13101",
          phones: ["09012345678"],
          hasAddress: true,
        },
        {
          id: "c:1",
          name: "市立図書館",
          category: "library",
          region: "13101",
          phones: ["0335812331"],
          hasAddress: true,
        },
      ],
    },
    {
      category: "medical",
      total: 1,
      rows: [
        {
          id: "c:2",
          name: "市立図書館",
          category: "medical",
          region: "13101",
          phones: ["0335812332"],
          hasAddress: false,
        },
      ],
    },
  ],
};

describe("search parity", () => {
  it("draws the same queries for a seed and keeps absent numbers out of the index", () => {
    const first = parityQueries(index, 1, counts);
    expect(parityQueries(index, 1, counts)).toEqual(first);
    expect(parityQueries(index, 2, counts)).not.toEqual(first);
    expect(first.substrings).toHaveLength(counts.substrings);
    expect(first.names).toHaveLength(counts.names);
    expect(first.numbers).toHaveLength(counts.numbers);
    expect(first.absent).toHaveLength(counts.absent);
    const listed = new Set(index.rows.flatMap((row) => row.phones));
    for (const number of first.numbers) {
      const parsed = normalizePhone(number);
      expect(parsed.ok, number).toBe(true);
      if (parsed.ok) expect(listed.has(`0${parsed.value.slice(3)}`)).toBe(true);
    }
    const spellings = [
      /^0[0-9]+(-[0-9]+)+$/u,
      /^0[0-9]+$/u,
      /^０[０-９－]+$/u,
      /^\(0[0-9]+\)( [0-9-]+)?$/u,
      /^\+81 [1-9][0-9-]+$/u,
    ];
    expect(spellings).toHaveLength(numberSpellings.length);
    for (const spelling of spellings)
      expect(
        first.numbers.some((number) => spelling.test(number)),
        String(spelling),
      ).toBe(true);
    expect(
      first.numbers.every((number) =>
        spellings.some((spelling) => spelling.test(number)),
      ),
    ).toBe(true);
    for (const number of first.absent) {
      expect(normalizePhone(number).ok, number).toBe(true);
      expect(listed.has(number), number).toBe(false);
    }
    const names = new Set(index.rows.map((row) => row.name));
    expect(first.names.every((name) => names.has(name))).toBe(true);
    expect(
      first.substrings.every((text) =>
        index.rows.some((row) => row.name.includes(text)),
      ),
    ).toBe(true);
  });

  it("finds no difference in equal results and names every kind of divergence", () => {
    expect(compareResults("図書館", results, results)).toEqual([]);
    const [library, medical] = results.groups;
    if (!library || !medical) throw new Error("Missing fixture groups");
    const variants: [string, ComparedResults][] = [
      ["total", { ...results, total: 4 }],
      ["categories", { ...results, groups: [medical, library] }],
      [
        "groups[0].total",
        { ...results, groups: [{ ...library, total: 3 }, medical] },
      ],
      [
        "groups[0].rows.length",
        {
          ...results,
          groups: [{ ...library, rows: library.rows.slice(1) }, medical],
        },
      ],
      ["groups[0].rows[0]", reorderPreviews(results)],
      [
        "groups[1].rows[0]",
        {
          ...results,
          groups: [
            library,
            {
              ...medical,
              rows: medical.rows.map((row) => ({
                ...row,
                phones: ["0335812331"],
              })),
            },
          ],
        },
      ],
      [
        "groups[1].rows[0]",
        {
          ...results,
          groups: [
            library,
            {
              ...medical,
              rows: medical.rows.map((row) => ({ ...row, hasAddress: true })),
            },
          ],
        },
      ],
    ];
    for (const [path, local] of variants)
      expect(
        compareResults("図書館", results, local).map((item) => item.path),
        path,
      ).toContain(path);
  });

  it("swaps only same-name rows that show different details", () => {
    const swapped = swapSameNameRows(index, 1);
    expect(swapped.names).toEqual(["市立図書館"]);
    const before = index.rows.map((row) => row.category);
    const after = swapped.index.rows.map((row) => row.category);
    expect(after).not.toEqual(before);
    expect(swapped.index.rows.map((row) => row.normalizedName)).toEqual(
      index.rows.map((row) => row.normalizedName),
    );
    expect(swapSameNameRows(index, 0).names).toEqual([]);
  });

  it("repeats its generator for a seed", () => {
    const first = seededRandom(7);
    const second = seededRandom(7);
    const draws = Array.from({ length: 5 }, () => first());
    expect(Array.from({ length: 5 }, () => second())).toEqual(draws);
    expect(draws.every((draw) => draw >= 0 && draw < 1)).toBe(true);
  });
});
