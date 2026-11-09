import * as v from "valibot";
import { describe, expect, it } from "vitest";
import source from "../../ios/Sources/PhonebookKit/PlaceReadings.json" with {
  type: "json",
};
import contract from "../../ios/Tests/PhonebookKitTests/PlaceReadingContract.json" with {
  type: "json",
};
import {
  categoryDefinitions,
  prefectureNames,
} from "../../src/core/catalog.ts";
import {
  PlaceReadingsSchema,
  readingPlaces,
} from "../../src/core/place-readings.ts";
import { searchForm } from "../../src/core/search-text.ts";

describe("verified place readings", () => {
  it("preserves the shared positives, ambiguities, folding, and exclusions", () => {
    for (const { text, ...expected } of contract)
      expect(readingPlaces(searchForm(text)), text).toEqual(expected);
  });

  it("covers the ordered prefectures and known categories within the compact resource budget", () => {
    const checked = v.parse(PlaceReadingsSchema, source);
    expect(checked.prefectures.map(([name]) => name)).toEqual(prefectureNames);
    expect(Object.keys(checked.categories)).toHaveLength(27);
    expect(Object.values(checked.categories).flat()).toHaveLength(32);
    expect(
      new TextEncoder().encode(JSON.stringify(source)).length,
    ).toBeLessThan(8192);
    for (const [position, [, kana]] of checked.prefectures.entries())
      expect(readingPlaces(searchForm(kana)).prefectures).toContain(
        String(position + 1).padStart(2, "0"),
      );
    for (const [id, readings] of Object.entries(checked.categories)) {
      expect(
        categoryDefinitions.some((category) => category.id === id),
        id,
      ).toBe(true);
      expect(new Set(readings).size).toBe(readings.length);
      for (const kana of readings)
        expect(readingPlaces(searchForm(kana)).categories).toContain(id);
    }
  });

  it("rejects incomplete or malformed reading documents", () => {
    for (const invalid of [
      { ...source, prefectures: source.prefectures.slice(1) },
      { ...source, categories: { library: [] } },
      { ...source, categories: { library: ["ト"] } },
      { ...source, categories: { library: ["図書館"] } },
      { ...source, categories: { "library|medical": ["トショカン"] } },
      { ...source, categories: { library: Array(9).fill("トショカン") } },
      { ...source, unexpected: true },
    ])
      expect(v.safeParse(PlaceReadingsSchema, invalid).success).toBe(false);
  });
});
