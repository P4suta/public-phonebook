import { kanji2number } from "@geolonia/japanese-numeral";

const maximumBlockNumber = 9999;

function blockNumber(text: string): string {
  try {
    const value = kanji2number(text);
    return Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= maximumBlockNumber
      ? String(value)
      : text;
  } catch {
    return text;
  }
}

export function normalizeAddress(input: string): string {
  return input
    .replace(/[０-９Ａ-Ｚａ-ｚ]+/gu, (text) => text.normalize("NFKC"))
    .replace(/[ｦ-ﾟ]+/gu, (text) => text.normalize("NFKC"))
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:〒\s*)?[0-9]{3}[-－−ー ]?[0-9]{4}(?:\s+|(?=[^0-9]))/u, "")
    .replace(
      /\s*(?:（(?:案内図|地図|所在地図)）|\((?:案内図|地図|所在地図)\))\s*$/u,
      "",
    )
    .replace(
      /[〇零一二三四五六七八九十百千]+(?=丁目|番地|番[0-9〇零一二三四五六七八九十百千]|号(?: |$))/gu,
      blockNumber,
    )
    .replace(
      /(?<=[0-9]番地の)[〇零一二三四五六七八九十百千]+(?= |$)/gu,
      blockNumber,
    )
    .replace(/([0-9]+)丁目(?=[0-9])/gu, "$1-")
    .replace(/([0-9]+)(?:番地の|番地|番)(?=[0-9])/gu, "$1-")
    .replace(/([0-9]+)号(?= |$)/gu, "$1")
    .replace(/([0-9]+)番地(?= |$)/gu, "$1")
    .replace(/(?<=[0-9])\s*[-‐‑‒–—―−－﹘﹣⁻₋ー]\s*(?=[0-9])/gu, "-")
    .trim();
}
