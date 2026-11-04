import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nameRank, searchQuery } from "../../src/core/search.ts";
import { searchForm, searchWords } from "../../src/core/search-text.ts";
import {
  type PlaceNames,
  placeHolds,
  rankWords,
  regionPlace,
  wordPlaces,
} from "../../src/core/word-match.ts";
import { referenceRank } from "./search-reference.ts";

const places: PlaceNames = {
  prefectures: [
    { code: "12", name: "千葉県" },
    { code: "13", name: "東京都" },
  ],
  municipalities: [
    { code: "12203", name: "市川市" },
    { code: "13101", name: "千代田区" },
  ],
  categories: [
    { id: "library", label: "図書館" },
    { id: "city_office", label: "市区町村の役所" },
  ],
};
const regions = ["12", "12203", "13", "13101"] as const;
const pieces = [
  "市川",
  "中央",
  "図書館",
  "トショカン",
  "としょかん",
  "千葉",
  "千代田",
  "役所",
  "セン",
  "ター",
  "せん-",
] as const;
const separators = [" ", "　", "  ", "\t", " 　 "] as const;

function rank(
  name: string,
  region: string,
  category: string,
  query: string,
): number {
  const words = searchWords(query);
  const held = words.map((word) => {
    const holding = wordPlaces(places, word);
    return {
      prefectures: new Set(holding.prefectures),
      municipalities: new Set(holding.municipalities),
      categories: new Set(holding.categories),
    };
  });
  return rankWords(searchForm(name), words, (index) => {
    const holding = held[index];
    return holding ? placeHolds(holding, regionPlace(region, category)) : false;
  });
}

function placeNames(region: string, category: string): string[] {
  return [
    places.prefectures.find((item) => item.code === region.slice(0, 2))?.name ??
      "",
    places.municipalities.find((item) => item.code === region)?.name ?? "",
    places.categories.find((item) => item.id === category)?.label ?? "",
  ];
}

describe("word matching", () => {
  it("matches and ranks like the reference for generated rows and queries", () => {
    const tiers = new Set<number>();
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...pieces), { minLength: 1, maxLength: 3 }),
        fc.constantFrom(...regions),
        fc.constantFrom("library", "city_office"),
        fc.array(fc.constantFrom(...pieces), { minLength: 1, maxLength: 3 }),
        fc.constantFrom(...separators),
        (name, region, category, query, separator) => {
          const typed = query.join(separator);
          const expected = referenceRank(
            name.join(""),
            placeNames(region, category),
            searchWords(typed),
          );
          tiers.add(expected);
          expect(rank(name.join(""), region, category, typed)).toBe(expected);
        },
      ),
      { seed: 20261106, numRuns: 3000 },
    );
    expect([...tiers].toSorted((left, right) => left - right)).toEqual([
      -1, 0, 1, 2, 3,
    ]);
  });

  it("finds 市川市中央図書館 and a 中央図書館 in 市川市 for 市川 図書館", () => {
    expect(rank("市川市中央図書館", "12203", "library", "市川 図書館")).toBe(
      nameRank.substring,
    );
    expect(rank("中央図書館", "12203", "library", "市川　図書館")).toBe(
      nameRank.place,
    );
    expect(rank("中央図書館", "13101", "library", "市川 図書館")).toBe(-1);
  });

  it("matches a word through the region alone or the category alone", () => {
    expect(rank("中央館", "12203", "city_office", "市川")).toBe(nameRank.place);
    expect(rank("中央館", "12", "city_office", "千葉")).toBe(nameRank.place);
    expect(rank("中央館", "13", "library", "図書館")).toBe(nameRank.place);
    expect(rank("中央館", "13", "library", "としょかん")).toBe(-1);
    expect(rank("中央館", "13", "city_office", "中央  役所")).toBe(
      nameRank.place,
    );
    expect(rank("市川中央館", "13101", "library", "市川 千代田 図書館")).toBe(
      nameRank.place,
    );
    expect(rank("市川中央館", "13101", "library", "市川 千葉")).toBe(-1);
  });

  it("keeps a one-word query's exact, prefix, and substring tiers", () => {
    expect(rank("図書館", "13", "library", "図書館")).toBe(nameRank.exact);
    expect(rank("図書館分館", "13", "library", " 図書館 ")).toBe(
      nameRank.prefix,
    );
    expect(rank("中央図書館", "13", "library", "図書館")).toBe(
      nameRank.substring,
    );
    expect(rank("トショカン", "13", "city_office", "としょかん")).toBe(
      nameRank.exact,
    );
  });

  it("leaves a telephone number to the telephone path", () => {
    expect(searchQuery("03 3581 2331").kind).toBe("telephone");
    expect(searchQuery("市川 03").kind).toBe("words");
  });
});
