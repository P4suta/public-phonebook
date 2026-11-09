import { readFile, writeFile } from "node:fs/promises";
import { searchQuery } from "../src/core/search.ts";
import {
  foldedCharacters,
  searchForm,
  searchWords,
} from "../src/core/search-text.ts";
import { rankWords } from "../src/core/word-match.ts";
import { seededRandom } from "./search-parity.ts";

/** The word splitting, match-and-rank, and telephone cases that the iPhone app's tests must answer like the website's code. */
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
  /** Each text with the E.164 number that search reads from it, or null when search reads it as words. */
  readonly telephones: readonly {
    readonly text: string;
    readonly number: string | null;
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
const generatedTelephones = 400;
const nearMissShare = 0.25;
const mobileShare = 0.5;
const decimalBase = 10;
const landlineSubscriberDigits = 8;
const mobileSubscriberDigits = 8;
const shortestAreaCode = 2;
const longestAreaCode = 5;
const longestExchange = 4;
const fullWidthOffset = 0xfee0;
const fullWidthHyphen = String.fromCodePoint(0xff0d);
const mobilePrefixes = ["090", "080", "070"] as const;
/** Characters around a query, with U+FEFF and U+0085, which JavaScript's `trim` and Foundation's whitespace set treat differently. */
const telephoneEdges = [
  "",
  " ",
  "\t",
  "\n",
  ideographicSpace,
  String.fromCodePoint(0xa0),
  String.fromCodePoint(0xfeff),
  String.fromCodePoint(0x85),
  String.fromCodePoint(0x2028),
] as const;
const fixedTelephones = [
  "03-3581-2331",
  "０３－３５８１－２３３１",
  "(03) 3581-2331",
  "（０３）３５８１－２３３１",
  "03(3581)2331",
  "+81 3 3581 2331",
  "+81-3-3581-2331",
  "＋８１ ３ ３５８１ ２３３１",
  "0335812331",
  "03 3581 2331",
  "090-1234-5678",
  "+81 90 1234 5678",
  "0120-123-456",
  "03-3581",
  "047",
  "0",
  "13-3581-2331",
  "+81 0 3 3581 2331",
  "03-3581-2331 内線123",
  "③-3581-2331",
  ...telephoneEdges.map((edge) => `${edge}03-3581-2331${edge}`),
] as const;
/** The ways a complete number is written, from its domestic digits split into area code, exchange, and subscriber. */
const telephoneSpellings: readonly ((groups: readonly string[]) => string)[] = [
  (groups) => groups.join("-"),
  (groups) => fullWidth(groups.join(fullWidthHyphen)),
  ([area = "", ...rest]) => `(${area}) ${rest.join("-")}`,
  ([area = "", ...rest]) => fullWidth(`（${area}）${rest.join("")}`),
  ([area = "", ...rest]) => `+81 ${[area.slice(1), ...rest].join(" ")}`,
  ([area = "", ...rest]) =>
    fullWidth(`＋８１${[area.slice(1), ...rest].join(ideographicSpace)}`),
  (groups) => groups.join(""),
];
/** Altered spellings that test the rule's edges: a dropped last digit, an extra letter, a leading 1, and a trunk 0 kept after `+81`. */
const nearMisses: readonly ((text: string, digits: string) => string)[] = [
  (text) => text.slice(0, -1),
  (text) => `${text}a`,
  (_, digits) => `1${digits.slice(1)}`,
  (_, digits) => `+81 ${digits}`,
];

function fullWidth(text: string): string {
  return text.replace(/[0-9+]/gu, (character) =>
    String.fromCodePoint((character.codePointAt(0) ?? 0) + fullWidthOffset),
  );
}

function randomDigits(count: number, random: () => number): string {
  return Array.from({ length: count }, () =>
    String(Math.floor(random() * decimalBase)),
  ).join("");
}

/** A random domestic number of 10 or 11 digits, split into an area code, an exchange, and a subscriber number. */
function randomTelephone(random: () => number): readonly string[] {
  const digits =
    random() < mobileShare
      ? `${pick(mobilePrefixes, random)}${randomDigits(mobileSubscriberDigits, random)}`
      : `0${1 + Math.floor(random() * (decimalBase - 1))}${randomDigits(landlineSubscriberDigits, random)}`;
  const area =
    shortestAreaCode +
    Math.floor(random() * (longestAreaCode - shortestAreaCode + 1));
  const exchange = 1 + Math.floor(random() * longestExchange);
  return [
    digits.slice(0, area),
    digits.slice(area, area + exchange),
    digits.slice(area + exchange),
  ];
}

function telephoneCase(text: string): {
  readonly text: string;
  readonly number: string | null;
} {
  const query = searchQuery(text);
  return { text, number: query.kind === "telephone" ? query.number : null };
}

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("A contract choice is missing");
  return item;
}

function rank(name: string, places: readonly string[], query: string): number {
  const words = searchWords(query);
  const forms = places.map(searchForm);
  return rankWords(
    searchForm(name),
    words,
    (index) => {
      const word = words[index] ?? "";
      return forms.some((form) => form.includes(word));
    },
    undefined,
  );
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
  const telephones = [
    ...fixedTelephones,
    ...Array.from({ length: generatedTelephones }, () => {
      const groups = randomTelephone(random);
      const spelled = pick(telephoneSpellings, random)(groups);
      const text =
        random() < nearMissShare
          ? pick(nearMisses, random)(spelled, groups.join(""))
          : spelled;
      const edge = pick(telephoneEdges, random);
      return `${edge}${text}${edge}`;
    }),
  ].map(telephoneCase);
  return {
    words: texts.map((text) => ({ text, words: [...searchWords(text)] })),
    ranks,
    telephones,
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
