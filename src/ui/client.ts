import { createIsomorphicFn } from "@tanstack/react-start";
import * as v from "valibot";
import {
  type Catalog,
  CatalogSchema,
  type Contact,
  ContactSchema,
  type GroupedSearchResponse,
  GroupedSearchResponseSchema,
  ProblemSchema,
  type SearchResponse,
  SearchResponseSchema,
  type Source,
  SourceSchema,
} from "../core/models.ts";
import { browserCredentials } from "../core/staging-access-policy.ts";

export class DirectoryError extends Error {
  readonly code: string;
  readonly requestId: string;

  constructor(code: string, requestId: string) {
    super(code);
    this.name = "DirectoryError";
    this.code = code;
    this.requestId = requestId;
  }
}

const request = createIsomorphicFn()
  .client(
    async (path: string, signal?: AbortSignal): Promise<Response> =>
      fetch(path, {
        signal: signal ?? null,
        credentials: browserCredentials(window.location.origin),
        headers: { Accept: "application/json" },
      }),
  )
  .server(async (path: string, signal?: AbortSignal): Promise<Response> => {
    const { env } = await import("cloudflare:workers");
    const { api } = await import("../server/api.ts");
    return api.fetch(
      new Request(new URL(path, env.PUBLIC_ORIGIN), {
        signal: signal ?? null,
      }),
      env,
    );
  });

export async function requestJson(
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await request(path, signal);
  const body: unknown = await response.json();
  if (!response.ok) {
    const problem = v.safeParse(ProblemSchema, body);
    throw new DirectoryError(
      problem.success ? problem.output.code : "unavailable",
      problem.success ? problem.output.requestId : "",
    );
  }
  return body;
}

export async function getCatalog(signal?: AbortSignal): Promise<Catalog> {
  return v.parse(CatalogSchema, await requestJson("/api/catalog", signal));
}

export async function getContact(
  id: string,
  signal?: AbortSignal,
): Promise<Contact> {
  return v.parse(
    ContactSchema,
    await requestJson(`/api/contacts/${encodeURIComponent(id)}`, signal),
  );
}

export async function getSource(
  id: string,
  signal?: AbortSignal,
): Promise<Source> {
  return v.parse(
    SourceSchema,
    await requestJson(`/api/sources/${encodeURIComponent(id)}`, signal),
  );
}

export async function getSearch(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  return v.parse(
    SearchResponseSchema,
    await requestJson(`/api/contacts?${params}`, signal),
  );
}

export async function getContactGroups(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<GroupedSearchResponse> {
  return v.parse(
    GroupedSearchResponseSchema,
    await requestJson(`/api/contact-groups?${params}`, signal),
  );
}
