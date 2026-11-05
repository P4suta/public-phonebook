import type { SearchIndex } from "./search-index.ts";
import { compactSearchText } from "./search-ranking-text.ts";
import { searchWords } from "./search-text.ts";

export interface PlaceCondition {
  readonly word: string;
  readonly prefectures: readonly string[];
  readonly municipalities: readonly string[];
}
export interface PlaceQuery {
  readonly stripped: string;
  readonly conditions: readonly PlaceCondition[];
}

export function placeDictionary(
  index: SearchIndex,
): ReadonlyMap<string, PlaceCondition> {
  const dictionary = new Map<string, PlaceCondition>();
  for (const [places, prefecture] of [
    [index.header.prefectures, true],
    [index.header.municipalities, false],
  ] as const) {
    for (const place of places) {
      const name = compactSearchText(place.name);
      const ward = name.match(/[市郡]([^市郡]+区)$/u)?.[1];
      const city = name.match(/^(.+?市).+区$/u)?.[1];
      const words = [
        name,
        name.replace(/[都府県市区町村]$/u, ""),
        ward,
        ward?.replace(/区$/u, ""),
        city,
        city?.replace(/市$/u, ""),
      ];
      for (const word of new Set(
        words.filter((value): value is string => !!value),
      )) {
        const previous = dictionary.get(word) ?? {
          word,
          prefectures: [],
          municipalities: [],
        };
        dictionary.set(word, {
          word,
          prefectures: prefecture
            ? [...previous.prefectures, place.code]
            : previous.prefectures,
          municipalities: prefecture
            ? previous.municipalities
            : [...previous.municipalities, place.code],
        });
      }
    }
  }
  return dictionary;
}

export function parsePlaceQuery(
  query: string,
  dictionary: ReadonlyMap<string, PlaceCondition>,
): PlaceQuery {
  const words = searchWords(query);
  const remaining = words.filter(
    (word) => !dictionary.has(compactSearchText(word)),
  );
  if (!remaining.length) return { stripped: query, conditions: [] };
  return {
    stripped: remaining.join(" "),
    conditions: words.flatMap((word) => {
      const condition = dictionary.get(compactSearchText(word));
      return condition ? [condition] : [];
    }),
  };
}

const prefectureCodeWidth = 2;
export function matchesPlaces(
  row: SearchIndex["rows"][number],
  query: PlaceQuery,
): boolean {
  const literal = compactSearchText(row.name);
  return query.conditions.every(
    (condition) =>
      condition.prefectures.includes(
        row.region.slice(0, prefectureCodeWidth),
      ) ||
      condition.municipalities.includes(row.region) ||
      literal.includes(condition.word),
  );
}
