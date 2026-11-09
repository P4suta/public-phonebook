import {
  parseSearchString,
  parseWebSearch,
  type WebSearch,
  webSearchParameters,
} from "./web-search.ts";

export interface ReturnTarget {
  readonly from: string;
  readonly local: boolean;
}

export function privateSearch(hash: string): WebSearch | null {
  if (!hash.startsWith("#") || !new URLSearchParams(hash.slice(1)).has("q"))
    return null;
  const parsed = parseWebSearch(parseSearchString(hash.slice(1)));
  return parsed.ok ? { ...parsed.value, cursor: "" } : null;
}

function rootFragment(from: string): string | null {
  if (from === "/") return "/";
  if (!/^\/[?#][^#]*$/u.test(from)) return null;
  const search = privateSearch(`#${from.slice(2)}`);
  if (!search) return null;
  const parameters = webSearchParameters(search).toString();
  return parameters ? `/#${parameters}` : "/";
}

export function localContactHref(path: string, from: string): string {
  return `${path}#from=${encodeURIComponent(rootFragment(from) ?? "/")}`;
}

export function privateReturnTarget(hash: string): ReturnTarget | null {
  if (!hash.startsWith("#")) return null;
  const parameters = new URLSearchParams(hash.slice(1));
  if (parameters.size !== 1) return null;
  const from = parameters.get("from");
  const target = from === null ? null : rootFragment(from);
  return target === null ? null : { from: target, local: true };
}

export function contactReturnHref(path: string, target: ReturnTarget): string {
  return target.local
    ? localContactHref(path, target.from)
    : `${path}?from=${encodeURIComponent(target.from)}`;
}
