import {
  groupPrecedes,
  wordRank as matchedWordRank,
  nextVisible,
} from "./local-search-policy.ts";

export {
  createRankedSearch,
  type RankedHit,
  type RankedSearch,
} from "./forgiving-search.ts";

import type { Result } from "./result.ts";
import {
  nameRank,
  nameRankValues,
  parseSearch,
  searchQuery,
} from "./search.ts";
import type { SearchIndex, SearchIndexRow } from "./search-index.ts";
import { previewLimit } from "./search-policy.ts";
import { rankWords, wordPlaces } from "./word-match.ts";

export const localPageSize = 30;
export const localPreviewSize = previewLimit(localPageSize);
const countryPrefix = "+81";
const trunkPrefix = "0";
const unmatchedRank = -1;
const prefectureCodeWidth = 2;

export type LocalQuery =
  | { readonly kind: "empty" }
  | { readonly kind: "telephone"; readonly number: string }
  | { readonly kind: "words"; readonly words: readonly string[] };

export interface CategoryMatches {
  readonly category: string;
  readonly rows: readonly number[];
}

export interface LocalMatches {
  readonly categories: readonly CategoryMatches[];
  readonly total: number;
}

export interface LocalGroup {
  readonly category: string;
  readonly total: number;
  readonly rows: readonly number[];
}

export interface LocalResults {
  readonly groups: readonly LocalGroup[];
  readonly total: number;
}

export interface LocalPage {
  readonly category: string;
  readonly total: number;
  readonly visible: number;
  readonly rows: readonly number[];
}

interface RankedCategory {
  readonly category: string;
  readonly rank: number;
  readonly first: number;
  readonly rows: readonly number[];
}

export function localQuery(input: string): Result<LocalQuery, "invalid_query"> {
  const parsed = parseSearch(new URLSearchParams([["q", input]]));
  if (!parsed.ok) return { ok: false, error: "invalid_query" };
  const query = searchQuery(parsed.value.q);
  return {
    ok: true,
    value:
      query.kind === "telephone"
        ? {
            kind: "telephone",
            number: `${trunkPrefix}${query.number.slice(countryPrefix.length)}`,
          }
        : query,
  };
}

function fail(message: string): never {
  throw new Error(message);
}

type WordRank = (position: number, row: SearchIndexRow | undefined) => number;

function wordRank(index: SearchIndex, words: readonly string[]): WordRank {
  const places = words.map((word) => {
    const holding = wordPlaces(index.header, word, "with-readings");
    return {
      regions: new Set<string>(
        index.header.regions.filter(
          (region) =>
            holding.prefectures.includes(
              region.slice(0, prefectureCodeWidth),
            ) || holding.municipalities.includes(region),
        ),
      ),
      categories: new Set(holding.categories),
    };
  });
  const placed = (word: number, source: SearchIndexRow | number): boolean => {
    const holding = places[word] ?? fail("A word has no places");
    return (
      (holding.categories.size > 0 &&
        holding.categories.has(
          typeof source === "number"
            ? (index.columns ?? fail("Search columns are missing")).categoryAt(
                source,
              )
            : source.category,
        )) ||
      (holding.regions.size > 0 &&
        holding.regions.has(
          typeof source === "number"
            ? (index.columns ?? fail("Search columns are missing")).regionAt(
                source,
              )
            : source.region,
        ))
    );
  };
  const ranks = index.columns?.nameRanks?.(words);
  if (ranks)
    return (position, row) => {
      if (words.length === 0) return unmatchedRank;
      let named = 0;
      let inPlaces = 0;
      let singleRank: number = nameRank.substring;
      for (let word = 0; word < words.length; word += 1) {
        const rank =
          ((ranks[word] ?? fail("A word has no name ranks"))[position] ?? 0) -
          1;
        if (rank >= 0) {
          named += 1;
          singleRank = rank;
        } else if (placed(word, row ?? position)) inPlaces += 1;
        else return unmatchedRank;
      }
      return matchedWordRank(words.length, named, inPlaces, singleRank);
    };
  return (position, row) =>
    rankWords(
      index.columns?.comparisonNames[position] ??
        row?.searchName ??
        fail("A search index name is missing"),
      words,
      placed,
      row ?? position,
    );
}

function forEachMatch(
  index: SearchIndex,
  query: Exclude<LocalQuery, { kind: "empty" }>,
  matched: (position: number, category: string, rank: number) => void,
): void {
  const telephone =
    query.kind === "telephone" && index.telephoneRows
      ? index.telephoneRows(query.number)
      : null;
  const columns = index.columns;
  const rankOf = wordRank(index, query.kind === "words" ? query.words : []);
  const count = telephone?.length ?? index.rows.length;
  for (let candidate = 0; candidate < count; candidate += 1) {
    const position = telephone?.[candidate] ?? candidate;
    const row =
      columns && (query.kind === "words" || telephone !== null)
        ? undefined
        : index.rows[position];
    const rank =
      query.kind === "telephone"
        ? telephone || row?.phones.includes(query.number)
          ? nameRank.exact
          : unmatchedRank
        : rankOf(position, row);
    if (rank !== unmatchedRank)
      matched(
        position,
        columns?.categoryAt(position) ??
          row?.category ??
          fail("A search index category is missing"),
        rank,
      );
  }
}

export function matchIndex(
  index: SearchIndex,
  query: LocalQuery,
): LocalMatches {
  if (query.kind === "empty") return { categories: [], total: 0 };
  const buckets = new Map<string, number[][]>();
  forEachMatch(index, query, (position, category, rank) => {
    let bucket = buckets.get(category);
    if (!bucket) {
      bucket = nameRankValues.map(() => []);
      buckets.set(category, bucket);
    }
    (bucket[rank] ?? fail("A search rank is out of range")).push(position);
  });
  const ranked: RankedCategory[] = [];
  for (const [category, bucket] of buckets) {
    const rank = bucket.findIndex((entries) => entries.length > 0);
    const first = bucket[rank]?.[0] ?? fail("A matched category has no rows");
    ranked.push({ category, rank, first, rows: bucket.flat() });
  }
  ranked.sort((left, right) =>
    groupPrecedes(left.rank, left.first, right.rank, right.first)
      ? -1
      : groupPrecedes(right.rank, right.first, left.rank, left.first)
        ? 1
        : 0,
  );
  return {
    categories: ranked.map(({ category, rows: matched }) => ({
      category,
      rows: matched,
    })),
    total: ranked.reduce((sum, item) => sum + item.rows.length, 0),
  };
}

export function orderedIndexRows(
  index: SearchIndex,
  query: LocalQuery,
): readonly number[] {
  if (query.kind === "empty") return [];
  const buckets: number[][] = nameRankValues.map(() => []);
  forEachMatch(index, query, (position, _category, rank) => {
    (buckets[rank] ?? fail("A search rank is out of range")).push(position);
  });
  return buckets.flat();
}

export function previewGroups(matches: LocalMatches): LocalResults {
  return {
    groups: matches.categories.map((item) => ({
      category: item.category,
      total: item.rows.length,
      rows: item.rows.slice(0, localPreviewSize),
    })),
    total: matches.total,
  };
}

export function continueCategory(
  matches: LocalMatches,
  category: string,
  visible: number,
): Result<LocalPage, "invalid_continuation"> {
  const rows =
    matches.categories.find((item) => item.category === category)?.rows ?? [];
  const total = rows.length;
  if (!Number.isSafeInteger(visible) || visible < 0 || visible > total)
    return { ok: false, error: "invalid_continuation" };
  const next = nextVisible(visible, total);
  return {
    ok: true,
    value: { category, total, visible: next, rows: rows.slice(visible, next) },
  };
}

export function searchLocalIndex(
  index: SearchIndex,
  input: string,
): Result<LocalResults, "invalid_query"> {
  const query = localQuery(input);
  return query.ok
    ? { ok: true, value: previewGroups(matchIndex(index, query.value)) }
    : query;
}
