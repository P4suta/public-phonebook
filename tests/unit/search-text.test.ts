import {
  normalizeName,
  normalizeNameLines,
} from "@public-phonebook/directory/identity";
import { parseSearch, searchQuery } from "@public-phonebook/directory/search";
import {
  foldedCharacters,
  maximumQueryWords,
  searchForm,
  searchNameLines,
  searchWords,
} from "@public-phonebook/directory/search-text";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { referenceForm, referenceWords } from "./search-reference.ts";

const ideographicSpace = String.fromCodePoint(0x3000);
const noBreak = String.fromCodePoint(0xa0);
const nextLine = String.fromCodePoint(0x85);
const zeroWidth = String.fromCodePoint(0x200b);

/** Characters that search folds or splits at, the edges of those sets, and ordinary text around them. */
const alphabet = [
  ...Array.from(
    "図書館市川中央ア ｱァヵヶケカかけゕゖトとーｰ-‐‑‒–—―−﹣－~〜ヷヴゔヽヾゝゞAaＡａ1１ｶﾞガが",
  ),
  ...[
    0x3099, 0x309b, 0x09, 0x0a, 0x0d, 0x0b, 0x0c, 0x85, 0xa0, 0x1680, 0x2000,
    0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0x200b, 0xfeff, 0x180e,
    0xfe00, 0xfe0f, 0xe0100,
  ].map((point) => String.fromCodePoint(point)),
];
const textArbitrary = fc
  .array(fc.constantFrom(...alphabet), { maxLength: 16 })
  .map((characters) => characters.join(""));

/** Respellings that a person may type for the same name. */
const variants: readonly (readonly [string, string])[] = [
  ["ト", "と"],
  ["ト", "ﾄ"],
  ["カ", "か"],
  ["ヶ", "ケ"],
  ["ヶ", "け"],
  ["ヵ", "カ"],
  ["ー", "-"],
  ["ー", "ｰ"],
  ["ー", "—"],
  ["ー", "−"],
  ["-", "‐"],
  ["A", "ａ"],
  ["1", "１"],
  ["ガ", "ｶﾞ"],
];
const variantPieces = [
  ...new Set(variants.map(([from]) => from)),
  "図書館",
  "市",
  "セ",
  "ン",
] as const;

describe("search text", () => {
  it("folds a name column without merging or changing individual names", () => {
    const name = textArbitrary.filter((text) => !text.includes("\n"));
    fc.assert(
      fc.property(fc.array(name, { minLength: 1, maxLength: 20 }), (names) => {
        expect(searchNameLines(names.join("\n"))).toEqual(
          names.map((name) => referenceForm(name)),
        );
      }),
      { seed: 20261108, numRuns: 2000 },
    );
    const names = [
      "ΟΣ",
      "Α",
      "Σ",
      "",
      "\uFE00",
      "\u3099",
      "\u0085",
      "\uFEFF",
      " 😀 Ａ ",
    ];
    expect(searchNameLines(names.join("\n"))).toEqual(
      names.map((name) => referenceForm(name)),
    );
    expect(normalizeNameLines(names.join("\n"))).toEqual(
      names.map((name) => normalizeName(name)),
    );
  });

  it("normalizes a name column like individual names at every Unicode boundary", () => {
    const name = textArbitrary.filter((text) => !text.includes("\n"));
    fc.assert(
      fc.property(fc.array(name, { minLength: 1, maxLength: 20 }), (names) => {
        expect(normalizeNameLines(names.join("\n"))).toEqual(
          names.map((name) => normalizeName(name)),
        );
      }),
      { seed: 20261109, numRuns: 2000 },
    );
  });

  it("splits and folds like the reference for every generated text", () => {
    fc.assert(
      fc.property(textArbitrary, (text) => {
        expect(searchWords(text)).toEqual(referenceWords(text));
        expect(searchForm(text)).toBe(referenceForm(text));
        expect(searchForm(searchForm(text))).toBe(searchForm(text));
        for (const word of searchWords(text)) {
          expect(word).not.toBe("");
          expect(word).not.toMatch(/\p{White_Space}/u);
        }
      }),
      { seed: 20261104, numRuns: 4000 },
    );
  });

  it("folds every character in its table to a character that stays folded", () => {
    for (const [from, to] of foldedCharacters) {
      expect(searchForm(from), from).toBe(referenceForm(from));
      expect(searchForm(to), to).toBe(searchForm(from));
    }
  });

  it("splits at full-width, repeated, and other Unicode spaces", () => {
    expect(searchWords(`市川${ideographicSpace}図書館`)).toEqual([
      "市川",
      "図書館",
    ]);
    expect(searchWords(`  市川 \t${ideographicSpace} 図書館  `)).toEqual([
      "市川",
      "図書館",
    ]);
    expect(searchWords(`市川${noBreak}図書館${nextLine}分館`)).toEqual([
      "市川",
      "図書館",
      "分館",
    ]);
    expect(searchWords(`市川${zeroWidth}図書館`)).toEqual([
      `市川${zeroWidth}図書館`,
    ]);
    expect(searchWords(` \t${ideographicSpace} `)).toEqual([]);
  });

  it("folds kana, long-vowel and dash marks, small ヶ and ヵ, width, and case", () => {
    expect(searchForm("センター")).toBe(searchForm("せんた-"));
    expect(searchForm("ｾﾝﾀｰ")).toBe(searchForm("センタ—"));
    expect(searchForm("市ヶ谷")).toBe(searchForm("市ケ谷"));
    expect(searchForm("市ヶ谷")).toBe(searchForm("市け谷"));
    expect(searchForm("一ヵ所")).toBe(searchForm("一カ所"));
    expect(searchForm("ＡＢＣ")).toBe("abc");
    expect(searchForm("ガ")).toBe(searchForm("ｶﾞ"));
    expect(searchForm(`辻${String.fromCodePoint(0xfe00)}`)).toBe("辻");
    expect(searchForm(`か${String.fromCodePoint(0xfe0f, 0x3099)}`)).toBe("が");
  });

  it("finds a name from any respelling of it", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...variantPieces), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.array(fc.nat(), { minLength: 6, maxLength: 6 }),
        (pieces, choices) => {
          const name = pieces.join("");
          const typed = pieces
            .map((piece, position) => {
              const options = variants.filter(([from]) => from === piece);
              const option =
                options[(choices[position] ?? 0) % (options.length + 1)];
              return option ? option[1] : piece;
            })
            .join("");
          expect(searchForm(typed)).toBe(searchForm(name));
        },
      ),
      { seed: 20261105, numRuns: 1000 },
    );
  });

  it("keeps a telephone spelling whole and caps the words of a name", () => {
    expect(searchQuery("03 3581 2331")).toEqual({
      kind: "telephone",
      number: "+81335812331",
    });
    expect(
      searchQuery(["０３", "３５８１", "２３３１"].join(ideographicSpace)).kind,
    ).toBe("telephone");
    expect(searchQuery("03 3581")).toEqual({
      kind: "words",
      words: ["03", "3581"],
    });
    const words = (count: number): URLSearchParams =>
      new URLSearchParams([
        ["q", Array.from({ length: count }, () => "館").join(" ")],
      ]);
    expect(maximumQueryWords).toBe(8);
    expect(parseSearch(words(maximumQueryWords)).ok).toBe(true);
    expect(parseSearch(words(maximumQueryWords + 1))).toEqual({
      ok: false,
      error: "invalid_query",
    });
    expect(
      parseSearch(new URLSearchParams([["q", "0 3 3 5 8 1 2 3 3 1"]])).ok,
    ).toBe(true);
  });
});
