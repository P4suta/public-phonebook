import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import * as v from "valibot";
import {
  type DirectoryDiscovery,
  DirectoryDiscoverySchema,
} from "../core/api-contract.ts";
import {
  admitsContentCoding,
  matchesEntityTag,
} from "../core/content-negotiation.ts";
import {
  directoryDeltaListing,
  manifestObjectKey,
  type PreparedDatasetManifest,
  PreparedDatasetManifestSchema,
  publicDatasetManifest,
  searchIndexLocation,
  searchIndexObjectKey,
} from "../core/dataset-storage.ts";
import { directoryDeltaFilePattern } from "../core/directory-delta.ts";
import { type FailureStatus, httpStatus } from "../core/http-status.ts";
import { sha256 } from "../core/identity.ts";
import {
  type Catalog,
  DatasetFileNameSchema,
  DigestSchema,
  type Problem,
  RowLocationSchema,
  VersionedDatasetManifestSchema,
} from "../core/models.ts";
import {
  type RowLocatorDecision,
  rowLocatorDecision,
} from "../core/row-locator-policy.ts";
import { parseSearch } from "../core/search.ts";
import { storesSearch } from "../core/search-policy.ts";
import { siteRequestAdmission } from "../core/site-request-policy.ts";
import { snapshotAdmission } from "../core/snapshot-policy.ts";
import { contactVCard } from "../core/vcard.ts";
import type { DirectoryBindings } from "./bindings.ts";
import {
  directoryDatabase,
  readCatalog,
  readContact,
  readRowContactId,
  readSource,
  readSources,
  searchContactGroups,
  searchContacts,
} from "./database.ts";
import type { DatasetReader } from "./datasets.ts";
import {
  cachedSearch,
  edgeSearchCache,
  type SearchCache,
  searchCacheKey,
  storeSearch,
} from "./search-cache.ts";

const corsPreflightMaxAgeSeconds = 86400;
const maximumUrlBytes = 8192;
const problemTypeBase = "https://www.dial.page/api/problems/";
const mutableCache = "public, no-cache, must-revalidate";
const immutableCache = "public, max-age=31536000, immutable";
const searchIndexCoding = "br";
const searchIndexMediaType = "application/octet-stream";
const rowPosition = /^(?:0|[1-9][0-9]*)$/u;
// D1 numbers rows from 1 in search index order, so a row position maps to the next rowid.
const rowidOffset = 1;
const ClientEncodingSchema = v.object({ clientAcceptEncoding: v.string() });
const versionedBase = "/api/v1";
const searchPaths = new Set(["/api/contacts", "/api/contact-groups"]);
const pinnedPaths = new Set([
  versionedBase,
  `${versionedBase}/datasets`,
  `${versionedBase}/dataset-deltas`,
]);
const sameOriginRequest = "same-origin";

export type DirectoryApiBindings = Pick<
  DirectoryBindings,
  "DB" | "APP_ENV" | "PUBLIC_ORIGIN"
> & {
  readonly DATASETS: DatasetReader;
  readonly DATASET_MANIFEST_SHA256?: string;
  readonly CF_VERSION_METADATA?: { readonly id: string };
  readonly SEARCH_CACHE?: SearchCache;
};

type ApiEnvironment = {
  Bindings: DirectoryApiBindings;
  Variables: { requestId: string };
};
type ApiContext = Context<ApiEnvironment>;
type RouteFamily = "site" | "open-data";

const allowedMethods: Record<RouteFamily, string> = {
  site: "GET, HEAD",
  "open-data": "GET, HEAD, OPTIONS",
};

function problem(
  c: ApiContext,
  code: Problem["code"],
  status: FailureStatus,
): Response {
  const titles: Record<Problem["code"], string> = {
    invalid_query: "The search parameters are invalid",
    conflicting_region: "The municipality does not belong to the prefecture",
    invalid_cursor: "The cursor does not match this search",
    snapshot_changed: "The dataset changed; restart the search",
    cross_origin: "Only this site's own pages can read this resource",
    not_found: "The resource was not found",
    method_not_allowed: "Use a method that the Allow header lists",
    not_acceptable: "No representation matches the accepted content codings",
    unavailable: "The directory is temporarily unavailable",
  };
  if (status === httpStatus.unavailable) c.header("Retry-After", "5");
  c.header("Content-Type", "application/problem+json");
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      type: `${problemTypeBase}${code}`,
      title: titles[code],
      status,
      code,
      requestId: c.get("requestId"),
    } satisfies Problem,
    status,
    { "Content-Type": "application/problem+json" },
  );
}

function settle(c: ApiContext, task: Promise<void>): Promise<void> {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    return task;
  }
  return Promise.resolve();
}

async function readPreparedManifest(
  c: ApiContext,
  catalog: Catalog,
): Promise<PreparedDatasetManifest | null> {
  const manifestSha256 = c.env.DATASET_MANIFEST_SHA256 || undefined;
  if (c.env.APP_ENV !== "development" && !manifestSha256) return null;
  const manifest = await c.env.DATASETS.get(
    manifestObjectKey(catalog.snapshot, manifestSha256),
  );
  if (!manifest) return null;
  const text = await new Response(manifest.body).text();
  if (manifestSha256 && (await sha256(text)) !== manifestSha256) return null;
  const value: unknown = JSON.parse(text);
  const parsed = v.parse(PreparedDatasetManifestSchema, value);
  return parsed.snapshot === catalog.snapshot &&
    parsed.contacts === catalog.contacts
    ? parsed
    : null;
}

/** Reads the visitor's own Accept-Encoding, which Cloudflare keeps in `cf` after it rewrites the header. */
function acceptedEncodings(request: Request): string | null {
  const cf = v.safeParse(
    ClientEncodingSchema,
    "cf" in request ? request.cf : undefined,
  );
  return cf.success
    ? cf.output.clientAcceptEncoding
    : request.headers.get("Accept-Encoding");
}

function parseRowPosition(text: string): number | null {
  if (!rowPosition.test(text)) return null;
  const row = Number(text);
  return Number.isSafeInteger(row) ? row : null;
}

const rowFailureStatus = {
  invalid_query: httpStatus.badRequest,
  snapshot_changed: httpStatus.conflict,
  not_found: httpStatus.notFound,
} as const satisfies Record<
  Exclude<RowLocatorDecision, "located">,
  FailureStatus
>;

function versioned(path: string): boolean {
  return path === versionedBase || path.startsWith(`${versionedBase}/`);
}

/** Open data is every versioned route, the dataset listing and files, and the delta listing; the site owns every other `/api` route. */
export function openDataPath(path: string): boolean {
  return (
    versioned(path) ||
    path === "/api/datasets" ||
    path.startsWith("/api/datasets/") ||
    path === "/api/dataset-deltas"
  );
}

function admitsParameter(
  family: RouteFamily,
  path: string,
  name: string,
): boolean {
  return family === "site"
    ? searchPaths.has(path)
    : pinnedPaths.has(path) && name === "snapshot";
}

function pinnedDiscovery(
  catalog: Pick<Catalog, "snapshot" | "generatedAt">,
): DirectoryDiscovery {
  const pin = (resource: string): string =>
    `${versionedBase}/${resource}?snapshot=${catalog.snapshot}`;
  return v.parse(DirectoryDiscoverySchema, {
    name: "Public Phonebook API",
    version: "1",
    snapshot: catalog.snapshot,
    generatedAt: catalog.generatedAt,
    datasets: pin("datasets"),
    datasetDeltas: pin("dataset-deltas"),
  });
}

/** Builds a router with the request checks that both route families share. */
function directoryRouter(family: RouteFamily): Hono<ApiEnvironment> {
  const router = new Hono<ApiEnvironment>();
  router.use("*", async (c, next) => {
    // Hono merges the context response's headers into a raw response only when that context response already exists.
    const { headers } = c.res;
    if (versioned(new URL(c.req.url).pathname))
      headers.set("X-Directory-API-Version", "1");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    await next();
  });
  if (family === "open-data")
    router.use(
      "*",
      cors({
        origin: "*",
        allowMethods: ["GET", "HEAD", "OPTIONS"],
        exposeHeaders: [
          "ETag",
          "X-Dataset-Snapshot",
          "X-Request-Id",
          "Retry-After",
          "X-Directory-API-Version",
        ],
        maxAge: corsPreflightMaxAgeSeconds,
      }),
    );
  router.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.header("X-Request-Id", c.get("requestId"));
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      c.header("Allow", allowedMethods[family]);
      return problem(c, "method_not_allowed", httpStatus.methodNotAllowed);
    }
    const sender = c.req.header("Sec-Fetch-Site");
    if (
      siteRequestAdmission(
        family === "site",
        sender !== undefined,
        sender === sameOriginRequest,
      ) === "cross_origin"
    )
      return problem(c, "cross_origin", httpStatus.forbidden);
    if (new TextEncoder().encode(c.req.url).length > maximumUrlBytes)
      return problem(c, "invalid_query", httpStatus.badRequest);
    try {
      const url = new URL(c.req.url);
      decodeURIComponent(url.pathname);
      decodeURIComponent(url.search.replaceAll("+", " "));
      if (
        [...url.searchParams.keys()].some(
          (name) => !admitsParameter(family, url.pathname, name),
        )
      )
        return problem(c, "invalid_query", httpStatus.badRequest);
    } catch {
      return problem(c, "invalid_query", httpStatus.badRequest);
    }
    await next();
  });
  router.notFound((c) => problem(c, "not_found", httpStatus.notFound));
  router.onError((_error, c) => {
    console.error(
      JSON.stringify({
        operation: "directory.read",
        outcome: "unavailable",
        requestId: c.get("requestId"),
        route: c.req.routePath,
      }),
    );
    return problem(c, "unavailable", httpStatus.unavailable);
  });
  return router;
}

function openDataApi(): Hono<ApiEnvironment> {
  const router = directoryRouter("open-data");
  router.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (pinnedPaths.has(url.pathname)) {
      const identities = url.searchParams.getAll("snapshot");
      const catalog = await readCatalog(directoryDatabase(c.env.DB));
      c.header("X-Dataset-Snapshot", catalog.snapshot);
      const decision = snapshotAdmission(
        identities.length > 0,
        identities.length <= 1,
        identities.every((value) => v.safeParse(DigestSchema, value).success),
        identities[0] === catalog.snapshot,
      );
      if (decision !== "accepted")
        return problem(
          c,
          decision,
          decision === "snapshot_changed"
            ? httpStatus.conflict
            : httpStatus.badRequest,
        );
    }
    await next();
  });

  router.get(versionedBase, async (c) =>
    c.json(pinnedDiscovery(await readCatalog(directoryDatabase(c.env.DB)))),
  );

  for (const base of ["/api", versionedBase] as const) {
    router.get(`${base}/datasets`, async (c) => {
      const catalog = await readCatalog(directoryDatabase(c.env.DB));
      const prepared = await readPreparedManifest(c, catalog);
      if (!prepared) return problem(c, "unavailable", httpStatus.unavailable);
      const parsed = publicDatasetManifest(prepared);
      c.header("X-Dataset-Snapshot", catalog.snapshot);
      c.header("Cache-Control", mutableCache);
      return c.json(
        base === versionedBase
          ? v.parse(VersionedDatasetManifestSchema, {
              ...parsed,
              files: parsed.files.map((file) => ({
                ...file,
                url: file.url.replace(/^\/api\//u, `${versionedBase}/`),
              })),
            })
          : parsed,
      );
    });

    router.get(`${base}/dataset-deltas`, async (c) => {
      const catalog = await readCatalog(directoryDatabase(c.env.DB));
      const prepared = await readPreparedManifest(c, catalog);
      if (!prepared) return problem(c, "unavailable", httpStatus.unavailable);
      c.header("X-Dataset-Snapshot", catalog.snapshot);
      c.header("Cache-Control", mutableCache);
      return c.json(directoryDeltaListing(prepared, base));
    });

    router.get(`${base}/datasets/:snapshot/:digest/:file`, async (c) => {
      const snapshot = c.req.param("snapshot");
      const digest = c.req.param("digest");
      const name = c.req.param("file");
      const complete = v.is(DatasetFileNameSchema, name);
      const delta = directoryDeltaFilePattern.test(name);
      if (
        !v.safeParse(DigestSchema, snapshot).success ||
        !v.safeParse(DigestSchema, digest).success ||
        (!complete && !delta)
      )
        return problem(c, "not_found", httpStatus.notFound);
      const object = await c.env.DATASETS.get(`${snapshot}/${digest}/${name}`);
      if (!object) return problem(c, "not_found", httpStatus.notFound);
      const headers = new Headers({
        "Content-Type":
          delta || name === "directory.tsv.br"
            ? "application/octet-stream"
            : "application/gzip",
        "Content-Length": String(object.size),
        ETag: object.httpEtag,
        "Cache-Control": immutableCache,
        "Content-Disposition": `attachment; filename="${name}"`,
        "X-Dataset-Snapshot": snapshot,
      });
      if (c.req.header("If-None-Match") === object.httpEtag)
        return new Response(null, { status: httpStatus.notModified, headers });
      return new Response(object.body, { headers });
    });
  }
  return router;
}

function siteApi(): Hono<ApiEnvironment> {
  const router = directoryRouter("site");
  router.use("*", async (c, next) => {
    const key = searchCacheKey(
      c.req.raw,
      c.env.DATASET_MANIFEST_SHA256,
      c.env.CF_VERSION_METADATA?.id,
    );
    const cache = key ? (c.env.SEARCH_CACHE ?? edgeSearchCache()) : null;
    if (!key || !cache) {
      await next();
      return;
    }
    const cached = await cachedSearch(cache, key);
    if (cached) {
      const response = new Response(cached.body, cached);
      response.headers.set("Cache-Control", mutableCache);
      return response;
    }
    await next();
    if (storesSearch(c.res.status))
      await settle(c, storeSearch(cache, key, c.res));
  });

  router.get("/api/catalog", async (c) => {
    const catalog = await readCatalog(directoryDatabase(c.env.DB));
    const etag = `"${await sha256(JSON.stringify(catalog))}"`;
    c.header("X-Dataset-Snapshot", catalog.snapshot);
    c.header("ETag", etag);
    c.header("Cache-Control", mutableCache);
    if (c.req.header("If-None-Match") === etag)
      return c.body(null, httpStatus.notModified);
    return c.json(catalog);
  });

  router.get("/api/contacts", async (c) => {
    const url = new URL(c.req.url);
    const search = parseSearch(url.searchParams);
    if (!search.ok) return problem(c, search.error, httpStatus.badRequest);
    const db = directoryDatabase(c.env.DB);
    const catalog = await readCatalog(db);
    const result = await searchContacts(db, search.value, catalog, url);
    if (!result.ok)
      return problem(
        c,
        result.error,
        result.error === "snapshot_changed"
          ? httpStatus.conflict
          : httpStatus.badRequest,
      );
    c.header("X-Dataset-Snapshot", catalog.snapshot);
    c.header("Cache-Control", mutableCache);
    if (result.value.links.next)
      c.header("Link", `<${result.value.links.next}>; rel="next"`);
    return c.json(result.value);
  });

  router.get("/api/contact-groups", async (c) => {
    const url = new URL(c.req.url);
    const search = parseSearch(url.searchParams);
    if (!search.ok) return problem(c, search.error, httpStatus.badRequest);
    const db = directoryDatabase(c.env.DB);
    const catalog = await readCatalog(db);
    const result = await searchContactGroups(db, search.value, catalog, url);
    if (!result.ok)
      return problem(
        c,
        result.error,
        result.error === "snapshot_changed"
          ? httpStatus.conflict
          : httpStatus.badRequest,
      );
    c.header("X-Dataset-Snapshot", catalog.snapshot);
    c.header("Cache-Control", mutableCache);
    return c.json(result.value);
  });

  router.get("/api/contacts/:id", async (c) => {
    const contact = await readContact(
      directoryDatabase(c.env.DB),
      c.req.param("id"),
    );
    return contact
      ? c.json(contact)
      : problem(c, "not_found", httpStatus.notFound);
  });

  router.get("/api/contacts/:id/contact.vcf", async (c) => {
    const contact = await readContact(
      directoryDatabase(c.env.DB),
      c.req.param("id"),
    );
    if (!contact) return problem(c, "not_found", httpStatus.notFound);
    return new Response(contactVCard(contact), {
      headers: {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": "attachment; filename=contact.vcf",
      },
    });
  });

  router.get("/api/sources", async (c) =>
    c.json({ data: await readSources(directoryDatabase(c.env.DB)) }),
  );

  router.get("/api/sources/:id", async (c) => {
    const source = await readSource(
      directoryDatabase(c.env.DB),
      c.req.param("id"),
    );
    return source
      ? c.json(source)
      : problem(c, "not_found", httpStatus.notFound);
  });

  router.get("/api/search-index", async (c) => {
    const catalog = await readCatalog(directoryDatabase(c.env.DB));
    const manifest = await readPreparedManifest(c, catalog);
    if (!manifest) return problem(c, "unavailable", httpStatus.unavailable);
    const location = searchIndexLocation(manifest);
    const etag = `"${await sha256(JSON.stringify(location))}"`;
    c.header("X-Dataset-Snapshot", catalog.snapshot);
    c.header("ETag", etag);
    c.header("Cache-Control", mutableCache);
    if (matchesEntityTag(c.req.header("If-None-Match"), etag))
      return c.body(null, httpStatus.notModified);
    return c.json(location);
  });

  router.get("/api/search-index/:snapshot/:sha256", async (c) => {
    const snapshot = c.req.param("snapshot");
    const digest = c.req.param("sha256");
    if (!v.is(DigestSchema, snapshot) || !v.is(DigestSchema, digest))
      return problem(c, "not_found", httpStatus.notFound);
    const catalog = await readCatalog(directoryDatabase(c.env.DB));
    if (snapshot !== catalog.snapshot)
      return problem(c, "not_found", httpStatus.notFound);
    const manifest = await readPreparedManifest(c, catalog);
    if (!manifest) return problem(c, "unavailable", httpStatus.unavailable);
    if (digest !== manifest.searchIndex.sha256)
      return problem(c, "not_found", httpStatus.notFound);
    c.header("Vary", "Accept-Encoding");
    if (!admitsContentCoding(acceptedEncodings(c.req.raw), searchIndexCoding))
      return problem(c, "not_acceptable", httpStatus.notAcceptable);
    const validators = {
      ETag: `"${digest}"`,
      "Cache-Control": immutableCache,
      Vary: "Accept-Encoding",
      "X-Dataset-Snapshot": snapshot,
    };
    if (matchesEntityTag(c.req.header("If-None-Match"), validators.ETag))
      return new Response(null, {
        status: httpStatus.notModified,
        headers: validators,
      });
    const object = await c.env.DATASETS.get(
      searchIndexObjectKey(snapshot, digest),
    );
    if (!object) return problem(c, "unavailable", httpStatus.unavailable);
    if (object.size !== manifest.searchIndex.bytes) {
      await object.body.cancel();
      return problem(c, "unavailable", httpStatus.unavailable);
    }
    return new Response(object.body, {
      headers: {
        ...validators,
        "Content-Type": searchIndexMediaType,
        "Content-Encoding": searchIndexCoding,
        "Content-Length": String(object.size),
      },
      encodeBody: "manual",
    });
  });

  router.get("/api/contacts/row/:snapshot/:row", async (c) => {
    const snapshot = c.req.param("snapshot");
    const position = parseRowPosition(c.req.param("row"));
    const row = position ?? 0;
    const db = directoryDatabase(c.env.DB);
    const catalog = await readCatalog(db);
    c.header("X-Dataset-Snapshot", catalog.snapshot);
    const decision = rowLocatorDecision(
      v.is(DigestSchema, snapshot) && position !== null,
      snapshot === catalog.snapshot,
      row,
      catalog.contacts,
    );
    if (decision !== "located")
      return problem(c, decision, rowFailureStatus[decision]);
    const id = await readRowContactId(db, row + rowidOffset);
    if (id === null) throw new Error("A located search index row is missing");
    c.header("Cache-Control", mutableCache);
    return c.json(v.parse(RowLocationSchema, { id }));
  });
  return router;
}

const openData = openDataApi();
const site = siteApi();

/** Sends each request to exactly one route family, so the site's routes never pass through the open-data middleware. */
const dispatch: Hono<ApiEnvironment>["fetch"] = (request, ...rest) =>
  (openDataPath(new URL(request.url).pathname) ? openData : site).fetch(
    request,
    ...rest,
  );

export const api = { fetch: dispatch } as const;
