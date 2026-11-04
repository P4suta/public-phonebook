import { kanjiVariantPairs } from "./kanji-variants.ts";

/** The most words that one name query may hold, which bounds the bound parameters of a D1 search. */
export const maximumQueryWords = 8;

const whitespaceRun = /\p{White_Space}+/u;
const variationSelector = /[\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/gu;
const hexadecimalRadix = 16;
const katakanaToHiragana = 0x60;
const firstKatakana = 0x30a1;
const lastKatakana = 0x30f6;
const katakanaIterationMarks = [0x30fd, 0x30fe] as const;
const dash = "-";
const dashVariants = [
  "ー",
  "ｰ",
  "‐",
  "‑",
  "‒",
  "–",
  "—",
  "―",
  "−",
  "﹣",
  "－",
] as const;
const smallKana = [
  ["ゕ", "か"],
  ["ゖ", "け"],
] as const;

function point(code: number): string {
  return String.fromCodePoint(code);
}

function katakanaFolds(): [string, string][] {
  const folds: [string, string][] = [];
  for (let code = firstKatakana; code <= lastKatakana; code += 1)
    folds.push([point(code), point(code - katakanaToHiragana)]);
  for (const code of katakanaIterationMarks)
    folds.push([point(code), point(code - katakanaToHiragana)]);
  return folds;
}

const smallKanaFolds = new Map<string, string>(smallKana);

/** Each character that search folds, mapped to the character it compares as. */
export const foldedCharacters: ReadonlyMap<string, string> = new Map([
  ...katakanaFolds().map(([from, to]): [string, string] => [
    from,
    smallKanaFolds.get(to) ?? to,
  ]),
  ...smallKana,
  ...dashVariants.map((variant): [string, string] => [variant, dash]),
  ...kanjiVariants(),
]);

/** Reads the generated variant table, whose pairs are a variant's and its representative's hexadecimal code points. */
export function kanjiVariants(): [string, string][] {
  return kanjiVariantPairs.split(" ").map((pair) => {
    const [from = "", to = ""] = pair
      .split(":")
      .map((point) =>
        String.fromCodePoint(Number.parseInt(point, hexadecimalRadix)),
      );
    return [from, to];
  });
}

const foldedCharacter = new RegExp(
  `[${Array.from(
    foldedCharacters.keys(),
    (character) =>
      `\\u{${(character.codePointAt(0) ?? 0).toString(hexadecimalRadix)}}`,
  ).join("")}]`,
  "gu",
);

/**
 * Folds the input variants that search ignores, character by character, without splitting words.
 * Variation selectors go first, so that composition can't stop at one, and compatibility composition and lowercase follow.
 * Katakana then become hiragana, small ヵ and ヶ become か and け, every long-vowel and dash mark becomes a hyphen-minus, and each kanji variant becomes its representative.
 * Canonical composition last joins a folded small kana with a following voiced mark, as the first composition would have, so folding twice changes nothing.
 */
export function foldSearchCharacters(text: string): string {
  return text
    .replace(variationSelector, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(
      foldedCharacter,
      (character) => foldedCharacters.get(character) ?? character,
    )
    .normalize("NFC");
}

/** Splits text into the folded words that search compares, at runs of any Unicode whitespace. */
export function searchWords(text: string): readonly string[] {
  return foldSearchCharacters(text)
    .split(whitespaceRun)
    .filter((word) => word !== "");
}

/** The comparison form of a name, region, or label: its folded words joined by one space. */
export function searchForm(text: string): string {
  return searchWords(text).join(" ");
}
