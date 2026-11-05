import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeRankingArtifact,
  encodeRankingArtifact,
  type RankingArtifact,
} from "../../src/core/search-ranking-artifact.ts";

const snapshot = "a".repeat(64);
const artifact: RankingArtifact = {
  snapshot,
  contacts: 3,
  analyzer: { engine: "sudachipy/0.7.0", dictionary: "b".repeat(64) },
  readings: ["トショカン", "ヤクショ", "カン"],
  lexicon: [["図書館", "トショカン", 2]],
  aliases: [[0, "としょかん"]],
  variants: [["舘", "館"]],
  unknownWeight: 1419,
  lexical: [
    ["図書", 3, [0, 2]],
    ["書館", 5, [0]],
  ],
  phonetic: [["としょ", 0, [0, 1, 2]]],
};

describe("ranking artifact", () => {
  it("preserves arbitrary ascending postings across byte boundaries", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 16_512 }), {
          minLength: 1,
          maxLength: 30,
        }),
        (values) => {
          const rows = values.toSorted((a, b) => a - b);
          const contacts = (rows.at(-1) ?? 0) + 1;
          const input = {
            ...artifact,
            contacts,
            readings: Array.from({ length: contacts }, () => "カン"),
            aliases: [],
            lexical: [["館", 1, rows]] as const,
            phonetic: [],
          };
          expect(
            decodeRankingArtifact(
              encodeRankingArtifact(input),
              snapshot,
              contacts,
            ),
          ).toEqual(input);
        },
      ),
      { seed: 20261105, numRuns: 50 },
    );
  });
  it("round trips delta postings and all snapshot evidence", () => {
    expect(
      decodeRankingArtifact(encodeRankingArtifact(artifact), snapshot, 3),
    ).toEqual(artifact);
  });

  it("rejects a different snapshot, count, version, or trailing bytes", () => {
    const bytes = encodeRankingArtifact(artifact);
    expect(() => decodeRankingArtifact(bytes, "c".repeat(64), 3)).toThrow(
      /snapshot/u,
    );
    expect(() => decodeRankingArtifact(bytes, snapshot, 2)).toThrow(/count/u);
    const wrong = bytes.slice();
    wrong[wrong.indexOf(10) - 1] = 50;
    expect(() => decodeRankingArtifact(wrong, snapshot, 3)).toThrow(/format/u);
    expect(() =>
      decodeRankingArtifact(new Uint8Array([...bytes, 0]), snapshot, 3),
    ).toThrow();
  });

  it("rejects unordered, duplicate, negative, or out-of-range ordinals", () => {
    for (const rows of [[1, 0], [0, 0], [-1], [3]])
      expect(() =>
        encodeRankingArtifact({ ...artifact, lexical: [["x", 1, rows]] }),
      ).toThrow();
  });

  it("rejects noncanonical varints and truncated postings", () => {
    const bytes = encodeRankingArtifact(artifact);
    expect(() =>
      decodeRankingArtifact(bytes.subarray(0, bytes.length - 1), snapshot, 3),
    ).toThrow();
    const broken = bytes.slice();
    broken[broken.length - 1] = 128;
    expect(() => decodeRankingArtifact(broken, snapshot, 3)).toThrow();
  });
});
