import { readFile, writeFile } from "node:fs/promises";
import {
  foldedCharacters,
  searchForm,
  searchWords,
} from "../src/core/search-text.ts";
import { rankWords } from "../src/core/word-match.ts";
import { seededRandom } from "./search-parity.ts";

/** The word splitting and match-and-rank cases that the iPhone app's tests must answer like the website's code. */
export const searchContractPath =
  "ios/Tests/PhonebookCoreTests/SearchContract.json";

export interface SearchContract {
  readonly words: readonly {
    readonly text: string;
    readonly words: readonly string[];
  }[];
  readonly ranks: readonly {
    readonly name: string;
    readonly places: readonly string[];
    readonly query: string;
    readonly rank: number;
  }[];
}

const contractSeed = 0x5ea4_c4;
const generatedTexts = 400;
const generatedRanks = 400;
const longestText = 12;
const longestQuery = 3;
const jsonIndentation = 2;
const hexadecimalRadix = 16;
const escapeWidth = 4;
const ideographicSpace = String.fromCodePoint(0x3000);
const voicedMark = String.fromCodePoint(0x3099);
/** Every character outside printable ASCII, which the JSON spells as an escape so that no invisible or confusable glyph reaches the file. */
const unseen = /[^\n\x20-\x7e]/gu;
/** The hexadecimal code points of voiced marks, whitespace, and invisible characters at the edges of the White_Space set. */
const unseenAlphabet =
  "3099 309b 9 a 85 a0 1680 2000 2028 202f 205f 3000 200b feff fe00 fe0f e0100";
const alphabet = [
  ...Array.from(
    "図書館市川中央ア ｱァヵヶケカかけゕゖトとーｰ-‐‑‒–—―−﹣－ヷヴゔヽヾゝゞAaＡａ1１ｶﾞガが",
  ),
  ...unseenAlphabet
    .split(" ")
    .map((point) =>
      String.fromCodePoint(Number.parseInt(point, hexadecimalRadix)),
    ),
];
const fixedTexts = [
  "市川 図書館",
  `市川${ideographicSpace}図書館`,
  `  市川 \t${ideographicSpace} 図書館  `,
  "センター",
  "ｾﾝﾀｰ",
  "市ヶ谷",
  "市ケ谷",
  "一ヵ所",
  `ゕ${voicedMark}`,
  `ヶ${voicedMark}`,
  "03 3581 2331",
  "",
  ` \t${ideographicSpace} `,
];
const names = [
  "市川市中央図書館",
  "中央図書館",
  "トショカン",
  "センター",
  "市ヶ谷図書館",
  "千代田区立図書館",
] as const;
const placeSets = [
  ["千葉県", "市川市", "図書館"],
  ["東京都", "千代田区", "市区町村の役所"],
  ["東京都", "", "図書館"],
] as const;
const queryWords = [
  "市川",
  "図書館",
  "としょかん",
  "千葉",
  "千代田",
  "役所",
  "せんた-",
  "市ケ谷",
  "中央",
] as const;
const separators = [" ", ideographicSpace, "  "] as const;

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("A contract choice is missing");
  return item;
}

function rank(name: string, places: readonly string[], query: string): number {
  const words = searchWords(query);
  const forms = places.map(searchForm);
  return rankWords(searchForm(name), words, (index) => {
    const word = words[index] ?? "";
    return forms.some((form) => form.includes(word));
  });
}

export function searchContract(): SearchContract {
  const random = seededRandom(contractSeed);
  const texts = [
    ...fixedTexts,
    ...Array.from(foldedCharacters, ([from, to]) => `${from}${to}`),
    ...Array.from({ length: generatedTexts }, () =>
      Array.from({ length: 1 + Math.floor(random() * longestText) }, () =>
        pick(alphabet, random),
      ).join(""),
    ),
  ];
  const ranks = Array.from({ length: generatedRanks }, () => {
    const name = pick(names, random);
    const places = pick(placeSets, random);
    const query = Array.from(
      { length: 1 + Math.floor(random() * longestQuery) },
      () => pick(queryWords, random),
    ).join(pick(separators, random));
    return {
      name,
      places: [...places],
      query,
      rank: rank(name, places, query),
    };
  });
  return {
    words: texts.map((text) => ({ text, words: [...searchWords(text)] })),
    ranks,
  };
}

function escaped(character: string): string {
  return Array.from(
    { length: character.length },
    (_, index) =>
      `\\u${character
        .charCodeAt(index)
        .toString(hexadecimalRadix)
        .padStart(escapeWidth, "0")}`,
  ).join("");
}

export function encodedSearchContract(): string {
  return `${JSON.stringify(searchContract(), null, jsonIndentation).replace(unseen, escaped)}\n`;
}

export async function readSearchContract(): Promise<string> {
  return readFile(searchContractPath, "utf8");
}

if (import.meta.main)
  await writeFile(searchContractPath, encodedSearchContract());
