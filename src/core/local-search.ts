import {
  groupPrecedes,
  nameRankAt,
  nextVisible,
} from "./local-search-policy.ts";
import { normalizePhone } from "./phone.ts";
import type { Result } from "./result.ts";
import {
  nameRank,
  nameRankValues,
  normalizeName,
  parseSearch,
} from "./search.ts";
import type { SearchIndex } from "./search-index.ts";
import { previewLimit } from "./search-policy.ts";

export const localPageSize = 30;
export const localPreviewSize = previewLimit(localPageSize);
const countryPrefix = "+81";
const trunkPrefix = "0";
const unmatchedRank = -1;

export type LocalQuery =
  | { readonly kind: "empty" }
  | { readonly kind: "telephone"; readonly number: string }
  | { readonly kind: "name"; readonly name: string };

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
  const { q } = parsed.value;
  const name = normalizeName(q);
  if (name === "") return { ok: true, value: { kind: "empty" } };
  const phone = normalizePhone(q);
  return {
    ok: true,
    value: phone.ok
      ? {
          kind: "telephone",
          number: `${trunkPrefix}${phone.value.slice(countryPrefix.length)}`,
        }
      : { kind: "name", name },
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function rowRank(
  row: SearchIndex["rows"][number],
  query: Exclude<LocalQuery, { kind: "empty" }>,
): number {
  if (query.kind === "telephone")
    return row.phones.includes(query.number) ? nameRank.exact : unmatchedRank;
  return nameRankAt(
    row.normalizedName.indexOf(query.name),
    row.normalizedName.length,
    query.name.length,
  );
}

export function matchIndex(
  index: SearchIndex,
  query: LocalQuery,
): LocalMatches {
  if (query.kind === "empty") return { categories: [], total: 0 };
  const buckets = new Map<string, number[][]>();
  const { rows } = index;
  for (let position = 0; position < rows.length; position += 1) {
    const row = rows[position] ?? fail("A search index row is missing");
    const rank = rowRank(row, query);
    if (rank === unmatchedRank) continue;
    let bucket = buckets.get(row.category);
    if (!bucket) {
      bucket = nameRankValues.map(() => []);
      buckets.set(row.category, bucket);
    }
    (bucket[rank] ?? fail("A search rank is out of range")).push(position);
  }
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
