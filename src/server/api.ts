import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi";
import * as v from "valibot";
import { categoryDefinitions, prefectureNames } from "../core/catalog.ts";
import { manifestObjectKey } from "../core/dataset-storage.ts";
import { type FailureStatus, httpStatus } from "../core/http-status.ts";
import { sha256 } from "../core/identity.ts";
import {
  CatalogSchema,
  ContactSchema,
  DatasetManifestSchema,
  GroupedSearchResponseSchema,
  type Problem,
  ProblemSchema,
  SearchResponseSchema,
  SourceSchema,
} from "../core/models.ts";
import { parseSearch } from "../core/search.ts";
import { contactVCard } from "../core/vcard.ts";
import type { DirectoryBindings } from "./bindings.ts";
import {
  directoryDatabase,
  readCatalog,
  readContact,
  readSource,
  readSources,
  searchContactGroups,
  searchContacts,
} from "./database.ts";
import type { DatasetReader } from "./datasets.ts";

const maximumQueryLength = 512;
const maximumCursorLength = 4096;
const maximumSearchLimit = 100;
const defaultSearchLimit = 30;
const exampleSearchLimit = 5;
const prefectureCodeWidth = 2;
const corsPreflightMaxAgeSeconds = 86400;
const maximumUrlBytes = 8192;
const problemTypeBase = "https://www.dial.page/api/problems/";
const mutableCache = "public, no-cache, must-revalidate";

export type DirectoryApiBindings = Pick<
  DirectoryBindings,
  "DB" | "APP_ENV" | "PUBLIC_ORIGIN"
> & {
  readonly DATASETS: DatasetReader;
  readonly DATASET_MANIFEST_SHA256?: string;
};

type ApiEnvironment = {
  Bindings: DirectoryApiBindings;
  Variables: { requestId: string };
};
type ApiContext = Context<ApiEnvironment>;

const searchParameters: NonNullable<
  Parameters<typeof describeRoute>[0]["parameters"]
> = [
  {
    name: "q",
    in: "query",
    example: "国立国会図書館",
    description:
      "Name substring or a complete Japanese telephone number. NFKC and case normalization. Maximum 512 UTF-8 bytes.",
    schema: { type: "string", default: "", maxLength: maximumQueryLength },
  },
  {
    name: "prefecture",
    in: "query",
    description: "Two-digit JIS prefecture code",
    schema: {
      type: "string",
      enum: prefectureNames.map((_, index) =>
        String(index + 1).padStart(prefectureCodeWidth, "0"),
      ),
    },
  },
  {
    name: "municipality",
    in: "query",
    description:
      "Five-digit municipality code from the catalog. Implies its prefecture. A conflicting prefecture is rejected.",
    schema: {
      type: "string",
      pattern: "^(0[1-9]|[1-3][0-9]|4[0-7])[0-9]{3}$",
    },
  },
  {
    name: "category",
    in: "query",
    schema: {
      type: "string",
      enum: categoryDefinitions.map((category) => category.id),
    },
  },
  {
    name: "limit",
    in: "query",
    example: exampleSearchLimit,
    schema: {
      type: "integer",
      minimum: 1,
      maximum: maximumSearchLimit,
      default: defaultSearchLimit,
    },
  },
  {
    name: "cursor",
    in: "query",
    description:
      "Opaque continuation token. Prefer links.next; do not construct or modify tokens.",
    schema: { type: "string", maxLength: maximumCursorLength },
  },
];

const failureResponses = Object.fromEntries(
  [
    httpStatus.badRequest,
    httpStatus.notFound,
    httpStatus.conflict,
    httpStatus.unavailable,
  ].map((status) => [
    status,
    {
      description:
        status === httpStatus.conflict
          ? "The dataset changed; restart without a cursor"
          : "An RFC 9457 problem with a request ID",
      content: {
        "application/problem+json": { schema: resolver(ProblemSchema) },
      },
    },
  ]),
);

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
    not_found: "The resource was not found",
    method_not_allowed: "Use GET, HEAD, or OPTIONS",
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

const api = new Hono<ApiEnvironment>();
api.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  await next();
});
api.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "OPTIONS"],
    exposeHeaders: [
      "ETag",
      "X-Dataset-Snapshot",
      "X-Request-Id",
      "Link",
      "Retry-After",
    ],
    maxAge: corsPreflightMaxAgeSeconds,
  }),
);
api.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  c.header("X-Request-Id", c.get("requestId"));
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    c.header("Allow", "GET, HEAD, OPTIONS");
    return problem(c, "method_not_allowed", httpStatus.methodNotAllowed);
  }
  if (new TextEncoder().encode(c.req.url).length > maximumUrlBytes)
    return problem(c, "invalid_query", httpStatus.badRequest);
  try {
    const url = new URL(c.req.url);
    decodeURIComponent(url.pathname);
    decodeURIComponent(url.search.replaceAll("+", " "));
    if (
      !["/api/contacts", "/api/contact-groups"].includes(url.pathname) &&
      url.searchParams.size > 0
    )
      return problem(c, "invalid_query", httpStatus.badRequest);
  } catch {
    return problem(c, "invalid_query", httpStatus.badRequest);
  }
  await next();
});

api.get("/api", (c) =>
  c.json({
    name: "Public Phonebook API",
    contacts: "/api/contacts",
    contactGroups: "/api/contact-groups",
    catalog: "/api/catalog",
    sources: "/api/sources",
    datasets: "/api/datasets",
    openapi: "/api/openapi.json",
    docs: "/developers",
  }),
);

api.get(
  "/api/catalog",
  describeRoute({
    operationId: "getCatalog",
    tags: ["Directory"],
    summary: "Get categories, regions, and the active dataset",
    responses: {
      [httpStatus.ok]: {
        description: "Directory catalog",
        content: { "application/json": { schema: resolver(CatalogSchema) } },
      },
      ...failureResponses,
    },
  }),
  async (c) => {
    const catalog = await readCatalog(directoryDatabase(c.env.DB));
    const etag = `"${await sha256(JSON.stringify(catalog))}"`;
    c.header("X-Dataset-Snapshot", catalog.snapshot);
    c.header("ETag", etag);
    c.header("Cache-Control", mutableCache);
    if (c.req.header("If-None-Match") === etag)
      return c.body(null, httpStatus.notModified);
    return c.json(catalog);
  },
);

api.get(
  "/api/contacts",
  describeRoute({
    operationId: "searchContacts",
    tags: ["Contacts"],
    summary:
      "Search facilities by name, telephone number, category, and region",
    description:
      "Exact names precede prefixes and substrings. Ties use normalized name and stable ID. Follow links.next until null. A cursor is bound to its query, limit, and dataset snapshot. Parameters must occur once; unknown parameters are rejected.",
    parameters: searchParameters,
    responses: {
      ...failureResponses,
      [httpStatus.ok]: {
        description: "A stable page of contacts",
        content: {
          "application/json": { schema: resolver(SearchResponseSchema) },
        },
      },
    },
  }),
  async (c) => {
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
  },
);

api.get(
  "/api/contact-groups",
  describeRoute({
    operationId: "searchContactGroups",
    tags: ["Contacts"],
    summary: "Preview matching contacts in every facility category",
    description:
      "Unfiltered categories each preview up to min(3, limit) contacts, ordered by their best name match. Group counts are exact. Follow each results.links.next through the flat contacts endpoint to retrieve all remaining matches. Category-selected searches return a regular page. A cursor requires a category. Query, limit, and dataset cursor bindings are unchanged.",
    parameters: searchParameters,
    responses: {
      ...failureResponses,
      [httpStatus.ok]: {
        description: "Disjoint category previews from one dataset snapshot",
        content: {
          "application/json": { schema: resolver(GroupedSearchResponseSchema) },
        },
      },
    },
  }),
  async (c) => {
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
  },
);

api.get(
  "/api/contacts/:id",
  describeRoute({
    operationId: "getContact",
    tags: ["Contacts"],
    summary: "Get a facility and its provenance",
    responses: {
      ...failureResponses,
      [httpStatus.ok]: {
        description: "Contact",
        content: { "application/json": { schema: resolver(ContactSchema) } },
      },
    },
  }),
  async (c) => {
    const contact = await readContact(
      directoryDatabase(c.env.DB),
      c.req.param("id"),
    );
    return contact
      ? c.json(contact)
      : problem(c, "not_found", httpStatus.notFound);
  },
);

api.get(
  "/api/contacts/:id/contact.vcf",
  describeRoute({
    operationId: "downloadContact",
    tags: ["Contacts"],
    summary: "Download one complete vCard",
    responses: {
      [httpStatus.ok]: {
        description: "vCard 3.0, UTF-8, CRLF, 75-byte folded lines",
        content: { "text/vcard": { schema: { type: "string" } } },
      },
      ...failureResponses,
    },
  }),
  async (c) => {
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
  },
);

api.get(
  "/api/sources",
  describeRoute({
    operationId: "listSources",
    tags: ["Sources"],
    summary: "List source provenance and import results",
    responses: {
      [httpStatus.ok]: {
        description: "Sources",
        content: {
          "application/json": {
            schema: resolver(v.strictObject({ data: v.array(SourceSchema) })),
          },
        },
      },
      ...failureResponses,
    },
  }),
  async (c) => c.json({ data: await readSources(directoryDatabase(c.env.DB)) }),
);
api.get(
  "/api/sources/:id",
  describeRoute({
    operationId: "getSource",
    tags: ["Sources"],
    summary: "Get source archive hashes and import counts",
    responses: {
      ...failureResponses,
      [httpStatus.ok]: {
        description: "Source",
        content: { "application/json": { schema: resolver(SourceSchema) } },
      },
    },
  }),
  async (c) => {
    const source = await readSource(
      directoryDatabase(c.env.DB),
      c.req.param("id"),
    );
    return source
      ? c.json(source)
      : problem(c, "not_found", httpStatus.notFound);
  },
);

api.get(
  "/api/datasets",
  describeRoute({
    operationId: "getDatasetManifest",
    tags: ["Datasets"],
    summary:
      "Get complete dataset download URLs, byte lengths, and SHA-256 hashes",
    responses: {
      [httpStatus.ok]: {
        description: "Current snapshot manifest",
        content: {
          "application/json": { schema: resolver(DatasetManifestSchema) },
        },
      },
      ...failureResponses,
    },
  }),
  async (c) => {
    const catalog = await readCatalog(directoryDatabase(c.env.DB));
    const manifestSha256 = c.env.DATASET_MANIFEST_SHA256 || undefined;
    if (c.env.APP_ENV !== "development" && !manifestSha256)
      return problem(c, "unavailable", httpStatus.unavailable);
    const manifest = await c.env.DATASETS.get(
      manifestObjectKey(catalog.snapshot, manifestSha256),
    );
    if (!manifest) return problem(c, "unavailable", httpStatus.unavailable);
    const text = await new Response(manifest.body).text();
    if (manifestSha256 && (await sha256(text)) !== manifestSha256)
      return problem(c, "unavailable", httpStatus.unavailable);
    const value: unknown = JSON.parse(text);
    const parsed = v.parse(DatasetManifestSchema, value);
    if (
      parsed.snapshot !== catalog.snapshot ||
      parsed.contacts !== catalog.contacts
    )
      return problem(c, "unavailable", httpStatus.unavailable);
    c.header("X-Dataset-Snapshot", catalog.snapshot);
    c.header("Cache-Control", mutableCache);
    return c.json(parsed);
  },
);

api.get(
  "/api/datasets/:snapshot/:digest/:file",
  describeRoute({
    operationId: "downloadDataset",
    tags: ["Datasets"],
    summary: "Download immutable complete JSONL, CSV, or vCard data",
    responses: {
      [httpStatus.ok]: {
        description: "Gzip archive with immutable caching and an ETag",
      },
      ...failureResponses,
    },
  }),
  async (c) => {
    const snapshot = c.req.param("snapshot");
    const digest = c.req.param("digest");
    const file = c.req.param("file");
    if (
      !/^[a-f0-9]{64}$/.test(snapshot) ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      !["contacts.jsonl.gz", "contacts.csv.gz", "contacts.vcf.gz"].includes(
        file,
      )
    )
      return problem(c, "not_found", httpStatus.notFound);
    const object = await c.env.DATASETS.get(`${snapshot}/${digest}/${file}`);
    if (!object) return problem(c, "not_found", httpStatus.notFound);
    const headers = new Headers({
      "Content-Type": file.endsWith(".gz")
        ? "application/gzip"
        : "application/json",
      "Content-Length": String(object.size),
      ETag: object.httpEtag,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Dataset-Snapshot": snapshot,
    });
    if (file.endsWith(".gz"))
      headers.set("Content-Disposition", `attachment; filename="${file}"`);
    if (c.req.header("If-None-Match") === object.httpEtag)
      return new Response(null, { status: httpStatus.notModified, headers });
    return new Response(object.body, { headers });
  },
);

api.get(
  "/api/openapi.json",
  openAPIRouteHandler(api, {
    documentation: {
      info: {
        title: "Public Phonebook API",
        version: "0.1.0",
        description:
          "Public facility contact data with source provenance. No API key is required.",
      },
      servers: [{ url: "/" }],
    },
  }),
);
api.notFound((c) => problem(c, "not_found", httpStatus.notFound));
api.onError((_error, c) => {
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

export { api };
export type DirectoryApi = typeof api;
