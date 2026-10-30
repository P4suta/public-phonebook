import type { Result } from "./result.ts";
import { parseSearch, type Search } from "./search.ts";

export type WebSearch = Pick<
  Search,
  "q" | "prefecture" | "municipality" | "category" | "cursor"
>;
export const emptyWebSearch: WebSearch = {
  q: "",
  prefecture: "",
  municipality: "",
  category: "",
  cursor: "",
};

export function webSearchParameters(search: WebSearch): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search))
    if (value) params.set(key, value);
  return params;
}

export function parseWebSearch(
  raw: Record<string, unknown>,
): Result<WebSearch, "invalid_query"> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (
      !["q", "prefecture", "municipality", "category", "cursor"].includes(
        key,
      ) ||
      typeof value !== "string"
    )
      return { ok: false, error: "invalid_query" };
    params.set(key, value);
  }
  const parsed = parseSearch(params);
  if (!parsed.ok) return { ok: false, error: "invalid_query" };
  const { q, prefecture, municipality, category, cursor } = parsed.value;
  return { ok: true, value: { q, prefecture, municipality, category, cursor } };
}

export function hasSearch(search: WebSearch): boolean {
  return Boolean(
    search.q.trim() ||
      search.prefecture ||
      search.category ||
      search.municipality,
  );
}

export function parseSearchString(search: string): Record<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [key, value] of new URLSearchParams(search)) {
    result.set(key, result.has(key) ? [result.get(key), value] : value);
  }
  return Object.fromEntries(result);
}

export function stringifySearchValues(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search))
    if (typeof value === "string" && value) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}
