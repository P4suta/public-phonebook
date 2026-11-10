import { foldSearchCharacters } from "./search-text.ts";

export const rankingVariants: readonly (readonly [string, string])[] = [
  ["舘", "館"],
  ["髙", "高"],
  ["﨑", "崎"],
  ["德", "徳"],
  ["濵", "浜"],
  ["濱", "浜"],
  ["邊", "辺"],
  ["邉", "辺"],
  ["齋", "斎"],
  ["齊", "斉"],
  ["澤", "沢"],
  ["國", "国"],
  ["學", "学"],
];

export function compactSearchText(text: string): string {
  return foldSearchCharacters(text).replace(/\p{White_Space}+/gu, "");
}

export function rankingName(
  text: string,
  variants: ReadonlyMap<string, string>,
): string {
  return Array.from(compactSearchText(text).normalize("NFC"))
    .map((point) => variants.get(point) ?? point)
    .join("");
}

export function searchGrams(text: string, width: number): string[] {
  const points = Array.from(text);
  if (points.length < width) return points.length ? [text] : [];
  const seen = new Set<string>();
  for (let i = 0; i + width <= points.length; i += 1)
    seen.add(points.slice(i, i + width).join(""));
  return [...seen];
}
