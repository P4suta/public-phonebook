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
import { boundedLimit, compatibleRegion } from "./search-policy.ts";

const maximumQueryBytes = 512;
const maximumCursorLength = 4096;
const prefectureCodeWidth = 2;
const hexadecimalRadix = 16;
export const nameRank = { exact: 0, prefix: 1, substring: 2 } as const;
export const nameRankValues = [
  nameRank.exact,
  nameRank.prefix,
  nameRank.substring,
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
      v.check(boundedLimit),
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

export async function searchKey(search: Search): Promise<string> {
  const phone = normalizePhone(search.q);
  const canonical = JSON.stringify([
    phone.ok ? ["phone", phone.value] : ["name", normalizeName(search.q)],
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
