import {
  localPageSize,
  localPreviewSize,
} from "@public-phonebook/directory/local-search";
import {
  groupPrecedes,
  type IndexReadiness,
  indexAdmission,
  nameRankAt,
  nextVisible,
  searchSource,
  wordRank,
} from "@public-phonebook/directory/local-search-policy";
import {
  nameRank,
  parseSearch,
  rankName,
} from "@public-phonebook/directory/search";
import { previewLimit } from "@public-phonebook/directory/search-policy";
import { maximumQueryWords } from "@public-phonebook/directory/search-text";
import { describe, expect, it } from "vitest";

const readiness: readonly IndexReadiness[] = [
  "loading",
  "ready",
  "unavailable",
];
const booleans = [false, true] as const;

describe("local search decisions", () => {
  it("ranks a match position exactly like the server's name rank", () => {
    const names = ["図書館", "図書館分館", "市立図書館", "館", "a", "ab", "ba"];
    const queries = ["図書館", "館", "a", "b", "ab", "書館分"];
    for (const name of names)
      for (const query of queries) {
        const rank = nameRankAt(name.indexOf(query), name.length, query.length);
        expect(rank).toBe(name.includes(query) ? rankName(name, query) : -1);
      }
    expect([
      nameRankAt(0, 3, 3),
      nameRankAt(0, 4, 3),
      nameRankAt(1, 4, 3),
    ]).toEqual([nameRank.exact, nameRank.prefix, nameRank.substring]);
  });

  it("ranks every count of named and placed words like the decided tiers", () => {
    for (let words = 1; words <= maximumQueryWords; words += 1)
      for (let named = 0; named <= words; named += 1)
        for (let placed = 0; named + placed <= words; placed += 1)
          for (const single of [0, 1, 2]) {
            const expected =
              named + placed < words
                ? -1
                : named < words
                  ? nameRank.place
                  : words === 1
                    ? single
                    : nameRank.substring;
            expect(wordRank(words, named, placed, single)).toBe(expected);
          }
  });

  it("orders entries by rank and then by row", () => {
    const entries = [
      [0, 5],
      [0, 9],
      [1, 0],
      [2, 1],
      [2, 3],
    ] as const;
    for (const [leftIndex, [rank, row]] of entries.entries())
      for (const [rightIndex, [otherRank, otherRow]] of entries.entries())
        expect(groupPrecedes(rank, row, otherRank, otherRow)).toBe(
          leftIndex < rightIndex,
        );
  });

  it("searches on the device only once the index is ready and never mid-composition", () => {
    for (const queried of booleans)
      for (const composing of booleans)
        for (const index of readiness) {
          const source = searchSource(queried, composing, index);
          if (composing || !queried) expect(source).toBe("wait");
          else expect(source).toBe(index === "ready" ? "local" : "server");
        }
  });

  it("continues a category by one server page without passing its total", () => {
    expect(nextVisible(0, 0)).toBe(0);
    expect(nextVisible(0, 7)).toBe(7);
    expect(nextVisible(3, 100)).toBe(33);
    expect(nextVisible(33, 100)).toBe(63);
    expect(nextVisible(93, 100)).toBe(100);
    expect(nextVisible(100, 100)).toBe(100);
  });

  it("admits an index only when every check passes and names the first failure", () => {
    expect(indexAdmission(10, 10, true, true, true, true)).toBe("admitted");
    expect(indexAdmission(9, 10, true, true, true, true)).toBe(
      "length_mismatch",
    );
    expect(indexAdmission(10, 10, false, false, false, false)).toBe(
      "digest_mismatch",
    );
    expect(indexAdmission(10, 10, true, false, false, false)).toBe(
      "signature_mismatch",
    );
    expect(indexAdmission(10, 10, true, true, false, false)).toBe("malformed");
    expect(indexAdmission(10, 10, true, true, true, false)).toBe(
      "snapshot_mismatch",
    );
  });

  it("uses the server's default page and preview sizes", () => {
    const parsed = parseSearch(new URLSearchParams());
    if (!parsed.ok) throw new Error("The empty search must parse");
    expect(localPageSize).toBe(parsed.value.limit);
    expect(localPreviewSize).toBe(previewLimit(parsed.value.limit));
    expect(nextVisible(0, localPageSize + 1)).toBe(parsed.value.limit);
  });
});
