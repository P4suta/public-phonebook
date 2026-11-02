import { describe, expect, it } from "vitest";
import { normalizePhone } from "../../src/core/phone.ts";
import { decodeSearchIndex } from "../../src/core/search-index.ts";
import {
  type ComparedResults,
  compareResults,
  parityQueries,
  reorderPreviews,
  seededRandom,
  swapSameNameRows,
} from "../../tools/search-parity.ts";
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
const counts = { substrings: 40, names: 20, numbers: 20, absent: 10 } as const;

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
        },
        {
          id: "c:1",
          name: "市立図書館",
          category: "library",
          region: "13101",
          phones: ["0335812331"],
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
