import * as v from "valibot";
import { DigestSchema } from "../core/models.ts";

export interface SearchCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

const edgeLifetimeSeconds = 300;
const cachedPaths = new Set([
  "/api/contacts",
  "/api/contact-groups",
  "/api/v1/contacts",
  "/api/v1/contact-groups",
]);

export function searchCacheKey(
  request: Request,
  manifestSha256: string | undefined,
  workerVersion: string | undefined,
): Request | null {
  const url = new URL(request.url);
  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    !cachedPaths.has(url.pathname) ||
    !v.is(DigestSchema, manifestSha256) ||
    !workerVersion
  )
    return null;
  return new Request(
    `${url.origin}/${encodeURIComponent(workerVersion)}/${manifestSha256}${url.pathname}${url.search}`,
  );
}

function isSearchCache(value: unknown): value is SearchCache {
  return (
    typeof value === "object" &&
    value !== null &&
    "match" in value &&
    typeof value.match === "function" &&
    "put" in value &&
    typeof value.put === "function"
  );
}

export function edgeSearchCache(): SearchCache | null {
  if (typeof caches === "undefined") return null;
  const cache: unknown = Reflect.get(caches, "default");
  return isSearchCache(cache) ? cache : null;
}

export async function cachedSearch(
  cache: SearchCache,
  key: Request,
): Promise<Response | null> {
  try {
    return (await cache.match(key)) ?? null;
  } catch {
    return null;
  }
}

function storedSearch(response: Response): Response {
  const stored = new Response(response.clone().body, response);
  stored.headers.set("Cache-Control", `public, max-age=${edgeLifetimeSeconds}`);
  stored.headers.delete("X-Request-Id");
  return stored;
}

export async function storeSearch(
  cache: SearchCache,
  key: Request,
  response: Response,
): Promise<void> {
  try {
    await cache.put(key, storedSearch(response));
  } catch {
    console.warn(
      JSON.stringify({ operation: "search.cache.store", outcome: "failed" }),
    );
  }
}
