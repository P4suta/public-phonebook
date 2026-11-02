import type { Result } from "./result.ts";
import { parseSearch, type Search } from "./search.ts";

export type WebSearch = Pick<Search, "q" | "category" | "cursor">;
export const emptyWebSearch: WebSearch = { q: "", category: "", cursor: "" };
const webSearchKeys: readonly string[] = ["q", "category", "cursor"];
const retiredFilters = ["prefecture", "municipality"] as const;
const continuationKeys = ["category", "cursor"] as const;

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
    if (!webSearchKeys.includes(key) || typeof value !== "string")
      return { ok: false, error: "invalid_query" };
    params.set(key, value);
  }
  const parsed = parseSearch(params);
  if (!parsed.ok) return { ok: false, error: "invalid_query" };
  const { q, category, cursor } = parsed.value;
  return { ok: true, value: { q, category, cursor } };
}

export function hasSearch(search: WebSearch): boolean {
  return Boolean(search.q.trim());
}

/**
 * Returns the search page URL without retired region filters, or null when the URL needs no change.
 * A cursor belongs to the filters it was issued for, and a continuation needs a search term.
 */
export function canonicalSearchPath(search: string): string | null {
  const params = new URLSearchParams(search);
  let changed = false;
  function remove(keys: readonly string[]): void {
    for (const key of keys)
      if (params.has(key)) {
        params.delete(key);
        changed = true;
      }
  }
  if (retiredFilters.some((key) => params.has(key)))
    remove([...retiredFilters, "cursor"]);
  if (!params.getAll("q").some((value) => value.trim()))
    remove(continuationKeys);
  if (!changed) return null;
  const text = params.toString();
  return text ? `/?${text}` : "/";
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
