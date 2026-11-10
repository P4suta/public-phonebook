import { buildRankingArtifact } from "@public-phonebook/data/search-ranking";
import {
  createRankedSearch,
  type RankedSearch,
} from "@public-phonebook/directory/local-search";
import {
  decodeSearchIndex,
  type SearchIndex,
  SearchIndexHeaderSchema,
} from "@public-phonebook/directory/search-index";
import type { RankingArtifact } from "@public-phonebook/directory/search-ranking-artifact";
import fc from "fast-check";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { modelDirectory } from "./local-search-fixture.ts";

interface Example {
  readonly name: string;
  readonly reading: string;
  readonly region: string;
}
interface SearchFixture {
  readonly index: SearchIndex;
  readonly artifact: RankingArtifact;
  readonly search: RankedSearch;
  names(query: string): readonly (string | undefined)[];
}

function fixture(
  examples: readonly Example[],
  aliases: readonly (readonly [number, string])[] = [],
): SearchFixture {
  const snapshot = "a".repeat(64);
  const directory = modelDirectory(
    examples.map((row, position) => ({
      id: `example:${position}`,
      name: row.name,
      category: "library",
      prefectureCode: row.region.slice(0, 2),
      municipalityCode: row.region.length > 2 ? row.region : null,
      phones: [{ e164: "+81312345678" }],
    })),
    snapshot,
  );
  const decoded = decodeSearchIndex(directory.bytes);
  const index = {
    ...decoded,
    header: v.parse(SearchIndexHeaderSchema, {
      ...decoded.header,
      municipalities: [
        ...decoded.header.municipalities,
        { code: "14101", prefectureCode: "14", name: "横浜市中区" },
      ],
    }),
  };
  const readings = directory.contacts.map(
    (row) =>
      examples.find((example) => example.name === row.name)?.reading ?? "",
  );
  const artifact = buildRankingArtifact(
    index,
    {
      readings,
      lexicon: [
        ["中央", "チュウオウ", 10],
        ["図書館", "トショカン", 10],
        ["千代田区", "チヨダク", 10],
        ["役所", "ヤクショ", 10],
        ["約所", "ヤクショ", 1],
      ],
    },
    aliases,
  );
  return {
    index,
    artifact,
    search: createRankedSearch(index, artifact),
    names: (query: string) =>
      createRankedSearch(index, artifact)
        .search(query)
        .map((hit) => index.rows[hit.row]?.name),
  };
}

const examples: readonly Example[] = [
  { name: "中央図書館", reading: "チュウオウトショカン", region: "13" },
  {
    name: "大阪市中央図書館",
    reading: "オオサカシチュウオウトショカン",
    region: "27",
  },
  { name: "千代田区役所", reading: "チヨダクヤクショ", region: "13101" },
  { name: "国立図書館", reading: "コクリツトショカン", region: "13" },
  { name: "國立図書館", reading: "コクリツトショカン", region: "27" },
];

describe("frozen device name ranking", () => {
  it("protects original written exact names before variant and reading matches", () => {
    const model = fixture(examples);
    expect(model.names("国立図書館")[0]).toBe("国立図書館");
    expect(model.names("國立図書館")[0]).toBe("國立図書館");
    expect(model.search.search("国立図書館")[0]?.score).toBe(1_000_000);
  });

  it("uses kana and anchored same-reading candidates", () => {
    const model = fixture(examples);
    expect(model.names("ちゅうおうとしょかん")[0]).toBe("中央図書館");
    expect(model.names("千代田区約所")[0]).toBe("千代田区役所");
  });

  it("prefers separate place conditions and preserves alternatives", () => {
    const model = fixture(examples);
    const names = model.names("大阪 中央図書館");
    expect(names[0]).toBe("大阪市中央図書館");
    expect(names).toContain("中央図書館");
  });

  it("associates a city word with its catalog wards", () => {
    const model = fixture([
      { name: "中央図書館", reading: "チュウオウトショカン", region: "13" },
      { name: "中央図書館", reading: "チュウオウトショカン", region: "14101" },
    ]);
    const first = model.search.search("横浜 中央図書館")[0];
    expect(model.index.rows[first?.row ?? -1]?.region).toBe("14101");
  });

  it("keeps empty and excessive inputs empty and bounds exact duplicates", () => {
    const model = fixture(examples);
    for (const query of ["", " \t\n", "館".repeat(257)])
      expect(model.search.search(query)).toEqual([]);
    const duplicates = fixture(
      Array.from({ length: 150 }, () => ({
        name: "中央図書館",
        reading: "チュウオウトショカン",
        region: "13",
      })),
    );
    expect(duplicates.search.search("中央図書館")).toHaveLength(100);
  });

  it("rejects a ranking artifact for a different snapshot", () => {
    const model = fixture(examples);
    expect(() =>
      createRankedSearch(model.index, {
        ...model.artifact,
        snapshot: "b".repeat(64),
      }),
    ).toThrow(/snapshot/u);
  });

  it("returns deterministic unique rows and bounded integer scores", () => {
    const model = fixture(examples);
    fc.assert(
      fc.property(
        fc
          .array(
            fc.constantFrom("中央", "館", "約", "かん", "大阪", " ", "𠮷"),
            { maxLength: 8 },
          )
          .map((parts) => parts.join("")),
        (query) => {
          const hits = model.search.search(query);
          expect(model.search.search(query)).toEqual(hits);
          expect(new Set(hits.map((hit) => hit.row)).size).toBe(hits.length);
          for (const hit of hits)
            expect(
              Number.isSafeInteger(hit.score) &&
                hit.score >= 0 &&
                hit.score <= 1_000_000,
            ).toBe(true);
          for (let i = 1; i < hits.length; i += 1)
            expect(hits[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(
              hits[i]?.score ?? 0,
            );
        },
      ),
      { seed: 20261105, numRuns: 100 },
    );
  });
});
