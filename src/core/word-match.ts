import { nameRankAt, wordRank } from "./local-search-policy.ts";
import { readingPlaces } from "./place-readings.ts";
import { searchForm } from "./search-text.ts";

const substringRank = 2;
const unmatchedRank = -1;
const prefectureCodeWidth = 2;
const municipalityCodeWidth = 5;

/** The region names and category labels that a word may match instead of a name. */
export interface PlaceNames {
  readonly prefectures: readonly {
    readonly code: string;
    readonly name: string;
  }[];
  readonly municipalities: readonly {
    readonly code: string;
    readonly name: string;
  }[];
  readonly categories: readonly {
    readonly id: string;
    readonly label: string;
  }[];
}

/** The prefecture codes, municipality codes, and category identifiers whose comparison form holds one word. */
export interface WordPlaces {
  readonly prefectures: readonly string[];
  readonly municipalities: readonly string[];
  readonly categories: readonly string[];
}

/** Where one row lies and what it is, by code. */
export interface RowPlace {
  readonly prefecture: string;
  readonly municipality: string | null;
  readonly category: string;
}

interface PlaceForms {
  readonly prefectures: readonly (readonly [string, string])[];
  readonly municipalities: readonly (readonly [string, string])[];
  readonly categories: readonly (readonly [string, string])[];
}

const formCache = new WeakMap<PlaceNames, PlaceForms>();

function placeForms(places: PlaceNames): PlaceForms {
  const cached = formCache.get(places);
  if (cached) return cached;
  const forms: PlaceForms = {
    prefectures: places.prefectures.map((item) => [
      item.code,
      searchForm(item.name),
    ]),
    municipalities: places.municipalities.map((item) => [
      item.code,
      searchForm(item.name),
    ]),
    categories: places.categories.map((item) => [
      item.id,
      searchForm(item.label),
    ]),
  };
  formCache.set(places, forms);
  return forms;
}

function holding(
  forms: readonly (readonly [string, string])[],
  word: string,
): string[] {
  return forms.filter(([, form]) => form.includes(word)).map(([code]) => code);
}

export function wordPlaces(
  places: PlaceNames,
  word: string,
  mode: "literal" | "with-readings" = "literal",
): WordPlaces {
  const forms = placeForms(places);
  const readings = mode === "with-readings" ? readingPlaces(word) : null;
  const prefectures = new Set(holding(forms.prefectures, word));
  const categories = new Set(holding(forms.categories, word));
  for (const code of readings?.prefectures ?? []) prefectures.add(code);
  for (const id of readings?.categories ?? []) categories.add(id);
  return {
    prefectures: places.prefectures
      .filter(({ code }) => prefectures.has(code))
      .map(({ code }) => code),
    municipalities: holding(forms.municipalities, word),
    categories: places.categories
      .filter(({ id }) => categories.has(id))
      .map(({ id }) => id),
  };
}

export function hasPlaces(places: WordPlaces): boolean {
  return (
    places.prefectures.length > 0 ||
    places.municipalities.length > 0 ||
    places.categories.length > 0
  );
}

/** Reads a row's prefecture and municipality from the one region code that the browser index keeps. */
export function regionPlace(region: string, category: string): RowPlace {
  return {
    prefecture: region.slice(0, prefectureCodeWidth),
    municipality: region.length === municipalityCodeWidth ? region : null,
    category,
  };
}

/** Whether a row's region or category holds a word, given the codes that hold it. */
export function placeHolds(
  places: {
    readonly prefectures: ReadonlySet<string>;
    readonly municipalities: ReadonlySet<string>;
    readonly categories: ReadonlySet<string>;
  },
  row: RowPlace,
): boolean {
  return (
    places.prefectures.has(row.prefecture) ||
    (row.municipality !== null &&
      places.municipalities.has(row.municipality)) ||
    places.categories.has(row.category)
  );
}

/**
 * Ranks a row's comparison name against folded words, or returns -1 when a word occurs neither in the name nor in the row's places.
 * `placed` answers whether the row's region or category holds the word at an index.
 */
export function rankWords(
  name: string,
  words: readonly string[],
  placed: (index: number) => boolean,
): number {
  let named = 0;
  let inPlaces = 0;
  for (const [index, word] of words.entries()) {
    if (name.includes(word)) named += 1;
    else if (placed(index)) inPlaces += 1;
    else return unmatchedRank;
  }
  const [single] = words;
  if (single === undefined) return unmatchedRank;
  const nameRank =
    words.length === 1 && named === 1
      ? nameRankAt(name.indexOf(single), name.length, single.length)
      : substringRank;
  return wordRank(words.length, named, inPlaces, nameRank);
}
