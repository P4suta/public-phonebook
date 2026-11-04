import * as v from "valibot";
import { normalizeAddress } from "./address.ts";
import {
  CategorySchema,
  MunicipalityCodeSchema,
  PrefectureCodeSchema,
} from "./catalog.ts";
import {
  IdentifierSchema,
  normalizeName,
  SortableNameSchema,
  sha256,
} from "./identity.ts";
import { DigestSchema } from "./models.ts";
import { normalizePhone } from "./phone.ts";
import type { Result } from "./result.ts";
import { compatibleRegion } from "./search-policy.ts";
import { maximumQueryWords, searchWords } from "./search-text.ts";
import { fitsSitePage } from "./site-request-policy.ts";

const maximumQueryBytes = 512;
const maximumCursorLength = 4096;
const prefectureCodeWidth = 2;
const hexadecimalRadix = 16;
/** The search tiers: a one-word query's exact, prefix, and substring name matches, then rows that match through their region or category. */
export const nameRank = {
  exact: 0,
  prefix: 1,
  substring: 2,
  place: 3,
} as const;
export const nameRankValues = [
  nameRank.exact,
  nameRank.prefix,
  nameRank.substring,
  nameRank.place,
] as const;
export type NameRank = (typeof nameRankValues)[number];

export const SearchSchema = v.strictObject({
  q: v.optional(
    v.pipe(
      v.string(),
      v.check(
        (text) =>
          new TextEncoder().encode(text).length <= maximumQueryBytes &&
          !text.includes("\0"),
      ),
    ),
    "",
  ),
  prefecture: v.optional(v.union([v.literal(""), PrefectureCodeSchema]), ""),
  municipality: v.optional(
    v.union([v.literal(""), MunicipalityCodeSchema]),
    "",
  ),
  category: v.optional(v.union([v.literal(""), CategorySchema]), ""),
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[1-9][0-9]?0?$/),
      v.transform(Number),
      v.integer(),
      v.check(fitsSitePage),
    ),
    "30",
  ),
  cursor: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(maximumCursorLength),
      v.regex(/^[A-Za-z0-9_-]*$/),
    ),
    "",
  ),
});

export type Search = v.InferOutput<typeof SearchSchema>;
export type SearchFailure =
  | "invalid_query"
  | "conflicting_region"
  | "invalid_cursor";

export function parseSearch(
  params: URLSearchParams,
): Result<Search, SearchFailure> {
  const values: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!Object.hasOwn(SearchSchema.entries, key) || Object.hasOwn(values, key))
      return { ok: false, error: "invalid_query" };
    values[key] = value;
  }
  const parsed = v.safeParse(SearchSchema, values);
  if (!parsed.success) return { ok: false, error: "invalid_query" };
  const search = parsed.output;
  if (!compatibleRegion(search.prefecture, search.municipality)) {
    return { ok: false, error: "conflicting_region" };
  }
  const query = searchQuery(search.q);
  if (query.kind === "words" && query.words.length > maximumQueryWords)
    return { ok: false, error: "invalid_query" };
  return {
    ok: true,
    value: {
      ...search,
      q: search.q.trim(),
      prefecture:
        search.prefecture ||
        (search.municipality
          ? v.parse(
              PrefectureCodeSchema,
              search.municipality.slice(0, prefectureCodeWidth),
            )
          : ""),
    },
  };
}

export { normalizeName };

/** A query as search reads it: nothing, a complete telephone number, or the folded words of a name. */
export type SearchQuery =
  | { readonly kind: "empty" }
  | { readonly kind: "telephone"; readonly number: string }
  | { readonly kind: "words"; readonly words: readonly string[] };

/** Reads a telephone spelling before splitting, so the spaces of a telephone number never split it into words. */
export function searchQuery(q: string): SearchQuery {
  const phone = normalizePhone(q);
  if (phone.ok) return { kind: "telephone", number: phone.value };
  const words = searchWords(q);
  return words.length ? { kind: "words", words } : { kind: "empty" };
}

export function nameTokens(normalized: string): readonly string[] {
  const points = Array.from(
    normalized,
    (point) => point.codePointAt(0)?.toString(hexadecimalRadix) ?? "",
  );
  const tokens = new Set(points.map((point) => `t${point}`));
  for (let index = 1; index < points.length; index += 1) {
    tokens.add(`t${points[index - 1]}x${points[index]}`);
  }
  return Array.from(tokens);
}

export function rankName(name: string, query: string): NameRank {
  if (name === query) return nameRank.exact;
  if (name.startsWith(query)) return nameRank.prefix;
  return nameRank.substring;
}

export function cleanAddress(address: string): string {
  return normalizeAddress(address);
}

/** Whether a contact's detail page shows an address, which names its result card's detail action. */
export function showsAddress(address: string): boolean {
  return cleanAddress(address) !== "";
}

export async function searchKey(search: Search): Promise<string> {
  const query = searchQuery(search.q);
  // A search without words keeps the identity it had before word search, so cursors issued earlier stay valid.
  const canonical = JSON.stringify([
    query.kind === "telephone"
      ? ["phone", query.number]
      : query.kind === "words"
        ? ["words", query.words]
        : ["name", ""],
    search.prefecture,
    search.municipality,
    search.category,
    search.limit,
  ]);
  return sha256(canonical);
}

export const CursorSchema = v.strictObject({
  snapshot: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  query: DigestSchema,
  rank: v.picklist(nameRankValues),
  name: v.pipe(
    SortableNameSchema,
    v.check((name) => normalizeName(name) === name),
  ),
  id: IdentifierSchema,
});
export type Cursor = v.InferOutput<typeof CursorSchema>;

export function encodeCursor(cursor: Cursor): string {
  v.parse(CursorSchema, cursor);
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeCursor(
  encoded: string,
): Result<Cursor, "invalid_cursor"> {
  if (
    encoded.length > maximumCursorLength ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  )
    return { ok: false, error: "invalid_cursor" };
  try {
    const bytes = Uint8Array.from(
      atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    );
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const parsed = v.safeParse(CursorSchema, value);
    return parsed.success
      ? { ok: true, value: parsed.output }
      : { ok: false, error: "invalid_cursor" };
  } catch {
    return { ok: false, error: "invalid_cursor" };
  }
}
