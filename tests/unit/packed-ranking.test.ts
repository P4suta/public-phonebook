import fc from "fast-check";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { unweightedDice } from "../../src/core/forgiving-search-policy.ts";
import { createRankedSearch } from "../../src/core/local-search.ts";
import {
  encodePackedRanking,
  lazyArray,
} from "../../src/core/packed-ranking.ts";
import { packedTrigramDice } from "../../src/core/reading-search.ts";
import { decodeSearchIndex } from "../../src/core/search-index.ts";
import { decodeRankingArtifact } from "../../src/core/search-ranking-artifact.ts";
import { searchGrams } from "../../src/core/search-ranking-text.ts";
import { buildRankingArtifact } from "../../tools/search-ranking.ts";
import { modelDirectory } from "./local-search-fixture.ts";

function fixture(): {
  readonly directory: ReturnType<typeof modelDirectory>;
  readonly index: ReturnType<typeof decodeSearchIndex>;
  readonly artifact: ReturnType<typeof buildRankingArtifact>;
} {
  const directory = modelDirectory(
    ["中央図書館", "國立図書館", "国立図書館", "中央図書館", "横浜市役所"].map(
      (name, row) => ({
        id: `packed:${row}`,
        name,
        category: "library",
        prefectureCode: row === 3 ? "27" : "13",
        municipalityCode: null,
        phones: [{ e164: "+81312345678" }],
      }),
    ),
    "a".repeat(64),
  );
  const index = decodeSearchIndex(directory.bytes);
  const artifact = buildRankingArtifact(
    index,
    {
      readings: index.rows.map((row) =>
        row.name === "横浜市役所"
          ? "ヨコハマシヤクショ"
          : "チュウオウトショカン",
      ),
      lexicon: [
        ["図書館", "トショカン", 10],
        ["図書館", "としょかん", 2],
      ],
    },
    [[0, "としょかん"]],
  );
  return { directory, index, artifact };
}

function section(
  bytes: Uint8Array,
  name: string,
): { readonly offset: number; readonly length: number } {
  const first = bytes.indexOf(10);
  const second = bytes.indexOf(10, first + 1);
  const metadata = v.parse(
    v.object({
      sections: v.array(
        v.tuple([
          v.string(),
          v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        ]),
      ),
    }),
    JSON.parse(new TextDecoder().decode(bytes.subarray(first + 1, second))),
  );
  let offset = Math.ceil((second + 1) / 4) * 4;
  for (const [key, length] of metadata.sections) {
    if (key === name) return { offset, length };
    offset = Math.ceil((offset + length) / 4) * 4;
  }
  throw new Error(`Missing fixture section: ${name}`);
}

describe("packed ranking", () => {
  it("computes the frozen trigram overlap without rebuilding candidate grams", () => {
    const text = fc
      .array(fc.constantFrom("あ", "館", "😀", "\ud800", "\udc00", "a"), {
        maxLength: 30,
      })
      .map((points) => points.join(""));
    fc.assert(
      fc.property(text, text, (query, name) => {
        const grams = searchGrams(query, 3);
        const own = searchGrams(name, 3);
        expect(packedTrigramDice(grams, name, own.length)).toBe(
          unweightedDice(grams, own),
        );
      }),
      { seed: 546901, numRuns: 1000 },
    );
  });
  it("views rows without reading the corpus during scorer construction", () => {
    const { directory, index, artifact } = fixture();
    const viewed = decodeSearchIndex(directory.bytes, true);
    expect(Array.from(viewed.rows)).toEqual(index.rows);
    expect(viewed.telephoneRows?.("0312345678")).toEqual([0, 1, 2, 3, 4]);
    expect(viewed.telephoneRows?.("031234567")).toEqual([]);
    expect(viewed.telephoneRows?.("03123456780")).toEqual([]);
    expect(viewed.nameAt?.(0)).toBe(index.rows[0]?.name);
    const packed = decodeRankingArtifact(
      encodePackedRanking(index, artifact, "b".repeat(64)),
      artifact.snapshot,
      artifact.contacts,
    );
    const unreadable = {
      ...viewed,
      rows: lazyArray(index.rows.length, (): never => {
        throw new Error("Eager corpus read");
      }),
    };
    expect(() => createRankedSearch(unreadable, packed)).not.toThrow();
  });

  it("keeps the first hundred short matches in the frozen order", () => {
    const directory = modelDirectory(
      Array.from({ length: 150 }, (_, row) => ({
        id: `duplicate:${row}`,
        name: row % 2 ? "中央図書館" : "中央第一図書館",
        category: "library",
        prefectureCode: "13",
        municipalityCode: null,
        phones: [{ e164: "+81312345678" }],
      })),
      "a".repeat(64),
    );
    const index = decodeSearchIndex(directory.bytes);
    const artifact = buildRankingArtifact(
      index,
      { readings: index.rows.map(() => "チュウオウトショカン"), lexicon: [] },
      [],
    );
    const packed = decodeRankingArtifact(
      encodePackedRanking(index, artifact, "b".repeat(64)),
      artifact.snapshot,
      artifact.contacts,
    );
    for (const query of [
      "中",
      "中央",
      "館",
      "中央図書館",
      "ちゅうおうとしょかん",
    ])
      expect(createRankedSearch(index, packed).search(query)).toEqual(
        createRankedSearch(index, artifact).search(query),
      );
  });

  it("preserves complete rankings through packed dictionaries and lazy rows", () => {
    const { index, artifact } = fixture();
    const bytes = encodePackedRanking(index, artifact, "b".repeat(64));
    const packed = decodeRankingArtifact(
      bytes,
      artifact.snapshot,
      artifact.contacts,
    );
    expect(packed.packed?.sourceSha256).toBe("b".repeat(64));
    const expected = createRankedSearch(index, artifact);
    const actual = createRankedSearch(index, packed);
    for (const query of [
      "中央図書館",
      "国立図書館",
      "國立図書館",
      "図",
      "図書",
      "ちゅうおうとしょかん",
      "中央図書感",
      "大阪 図書館",
      "横浜 約所",
      "",
      "館".repeat(257),
    ])
      expect(actual.search(query), query).toEqual(expected.search(query));
  });

  it("rejects mismatched identities, truncation, and extra bytes", () => {
    const { index, artifact } = fixture();
    const bytes = encodePackedRanking(index, artifact, "b".repeat(64));
    expect(() =>
      decodeRankingArtifact(bytes, "c".repeat(64), artifact.contacts),
    ).toThrow();
    expect(() =>
      decodeRankingArtifact(bytes, artifact.snapshot, artifact.contacts + 1),
    ).toThrow();
    expect(() =>
      decodeRankingArtifact(
        bytes.subarray(0, bytes.length - 1),
        artifact.snapshot,
        artifact.contacts,
      ),
    ).toThrow();
    expect(() =>
      decodeRankingArtifact(
        new Uint8Array([...bytes, 0]),
        artifact.snapshot,
        artifact.contacts,
      ),
    ).toThrow();
  });

  it("rejects corrupt posting bytes, weights, permutations, and string offsets", () => {
    const { index, artifact } = fixture();
    const bytes = encodePackedRanking(index, artifact, "b".repeat(64));
    for (const name of [
      "lexical:values",
      "weights",
      "original:order",
      "offsets",
    ]) {
      const broken = bytes.slice();
      const part = section(broken, name);
      const view = new DataView(broken.buffer);
      if (name === "lexical:values") broken[part.offset] = 0;
      else if (name === "weights") view.setUint32(part.offset, 0, true);
      else if (name === "original:order")
        view.setUint32(
          part.offset + 4,
          view.getUint32(part.offset, true),
          true,
        );
      else view.setUint32(part.offset + 4, 0xffff_ffff, true);
      expect(
        () =>
          decodeRankingArtifact(broken, artifact.snapshot, artifact.contacts),
        name,
      ).toThrow();
    }
  });
});
