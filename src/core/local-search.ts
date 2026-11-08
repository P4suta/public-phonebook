import { groupPrecedes, nextVisible } from "./local-search-policy.ts";

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
import type { SearchIndex } from "./search-index.ts";
import { previewLimit } from "./search-policy.ts";
import {
  placeHolds,
  rankWords,
  regionPlace,
  wordPlaces,
} from "./word-match.ts";

export const localPageSize = 30;
export const localPreviewSize = previewLimit(localPageSize);
const countryPrefix = "+81";
const trunkPrefix = "0";
const unmatchedRank = -1;

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

type WordRank = (name: string, region: string, category: string) => number;

function wordRank(index: SearchIndex, words: readonly string[]): WordRank {
  const places = words.map((word) => {
    const holding = wordPlaces(index.header, word);
    return {
      prefectures: new Set(holding.prefectures),
      municipalities: new Set(holding.municipalities),
      categories: new Set(holding.categories),
    };
  });
  return (name, region, category) =>
    rankWords(name, words, (word) =>
      placeHolds(
        places[word] ?? fail("A word has no places"),
        regionPlace(region, category),
      ),
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
    const category =
      columns?.categoryAt(position) ??
      row?.category ??
      fail("A search index row is missing");
    const rank =
      query.kind === "telephone"
        ? telephone || row?.phones.includes(query.number)
          ? nameRank.exact
          : unmatchedRank
        : rankOf(
            columns?.comparisonNames[position] ??
              row?.searchName ??
              fail("A search index name is missing"),
            columns?.regionAt(position) ??
              row?.region ??
              fail("A search index region is missing"),
            category,
          );
    if (rank !== unmatchedRank) matched(position, category, rank);
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
