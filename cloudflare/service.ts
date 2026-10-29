export interface Services {
  assets(request: Request): Promise<Response>;
  origin(request: Request): Promise<Response>;
}

const HTTP = {
  noContent: 204,
  notModified: 304,
  badRequest: 400,
  notFound: 404,
  methodNotAllowed: 405,
  snapshotChanged: 409,
  unavailable: 503,
} as const;
const MAX_REQUEST_TARGET_BYTES = 8192;
const DIRECTORY_ORIGIN = "http://phonebook.internal";

const protections: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

interface ApiFailureStatus {
  readonly invalid_query: typeof HTTP.badRequest;
  readonly not_found: typeof HTTP.notFound;
  readonly method_not_allowed: typeof HTTP.methodNotAllowed;
  readonly snapshot_changed: typeof HTTP.snapshotChanged;
  readonly unavailable: typeof HTTP.unavailable;
}

type ApiFailureCode = keyof ApiFailureStatus;

interface ApiFailureDefinition<Status extends number> {
  readonly status: Status;
  readonly title: string;
  readonly detail: string;
}

const apiFailures: {
  readonly [Code in ApiFailureCode]: ApiFailureDefinition<
    ApiFailureStatus[Code]
  >;
} = {
  invalid_query: {
    status: 400,
    title: "Invalid query",
    detail:
      "Use valid URL encoding and supported parameters. See /api/docs for the 8192-byte request limit.",
  },
  not_found: {
    status: 404,
    title: "Not found",
    detail:
      "This resource does not exist in the current snapshot. Discover available resources at /api.",
  },
  method_not_allowed: {
    status: 405,
    title: "Method not allowed",
    detail:
      "Use GET or HEAD to read public data. OPTIONS is available for browser preflight requests.",
  },
  snapshot_changed: {
    status: 409,
    title: "Snapshot changed",
    detail:
      "The active snapshot has changed. Start again from /api and follow its new links to avoid mixing snapshots.",
  },
  unavailable: {
    status: 503,
    title: "Temporarily unavailable",
    detail:
      "The service is temporarily unavailable. Wait for Retry-After before retrying this request.",
  },
};

function apiFailure(status: number, id: string): Response {
  const code: ApiFailureCode =
    status === HTTP.badRequest
      ? "invalid_query"
      : status === HTTP.notFound
        ? "not_found"
        : status === HTTP.methodNotAllowed
          ? "method_not_allowed"
          : status === HTTP.snapshotChanged
            ? "snapshot_changed"
            : "unavailable";
  const definition = apiFailures[code];
  return new Response(
    JSON.stringify({
      type: `/api/docs#${code.replaceAll("_", "-")}`,
      title: definition.title,
      status: definition.status,
      detail: definition.detail,
      instance: `urn:public-phonebook:request:${id}`,
      code,
      request_id: id,
      invalid_parameters:
        code === "invalid_query"
          ? [{ name: "request", reason: definition.detail }]
          : [],
    }),
    {
      status: definition.status,
      headers: {
        "content-type": "application/problem+json",
        ...(code === "unavailable" ? { "retry-after": "1" } : {}),
        ...(code === "method_not_allowed"
          ? { allow: "GET, HEAD, OPTIONS" }
          : {}),
      },
    },
  );
}

function failure(status: number, id: string, publicApi: boolean): Response {
  if (publicApi) return apiFailure(status, id);
  const title =
    status === HTTP.methodNotAllowed
      ? "この操作は できません"
      : status === HTTP.badRequest
        ? "この検索は できません"
        : "読みこめませんでした";
  return new Response(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Public Phonebook</title><link rel="stylesheet" href="/style.css"></head><body><a class="skip-link" href="#main">本文へ移動</a><header class="site-header"><h1><a href="/">Public Phonebook</a></h1><nav><a href="/data">データと出典</a></nav></header><main id="main" class="detail-page"><section class="error-panel"><h2>${title}</h2><p>時間をおいてもう一度お試しください。</p><a class="button" href="/">さがし直す</a><details><summary>問い合わせ用の情報</summary><code>${id}</code></details></section></main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...(status === HTTP.unavailable ? { "retry-after": "5" } : {}),
        ...(status === HTTP.methodNotAllowed ? { allow: "GET, HEAD" } : {}),
      },
    },
  );
}

export async function handleRequest(
  request: Request,
  services: Services,
): Promise<Response> {
  const id = crypto.randomUUID();
  const url = new URL(request.url);
  const publicApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  const asset =
    url.pathname === "/style.css" ||
    url.pathname === "/app.js" ||
    url.pathname === "/api.js" ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/fonts/");
  let response: Response;
  if (
    new TextEncoder().encode(url.pathname + url.search).length >
    MAX_REQUEST_TARGET_BYTES
  )
    response = failure(HTTP.badRequest, id, publicApi);
  else if (publicApi && request.method === "OPTIONS")
    response = new Response(null, { status: HTTP.noContent });
  else if (!["GET", "HEAD"].includes(request.method))
    response = failure(HTTP.methodNotAllowed, id, publicApi);
  else {
    const headers = new Headers();
    for (const name of ["accept", "if-none-match"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const target = new URL(asset ? url.origin : DIRECTORY_ORIGIN);
    target.pathname = url.pathname;
    target.search = asset ? "" : url.search;
    const forwarded = new Request(target, {
      method: request.method,
      headers,
      signal: request.signal,
      redirect: "manual",
    });
    try {
      response = await (asset
        ? services.assets(forwarded)
        : services.origin(forwarded));
    } catch {
      console.error(
        JSON.stringify({
          operation: "origin",
          outcome: "unavailable",
          request_id: id,
        }),
      );
      response = failure(HTTP.unavailable, id, publicApi);
    }
  }
  if (
    publicApi &&
    response.status >= HTTP.badRequest &&
    response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() !== "application/problem+json"
  ) {
    const status = response.status;
    await response.body?.cancel();
    response = apiFailure(status, id);
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(protections))
    headers.set(name, value);
  headers.set(
    "cache-control",
    (asset || url.pathname === "/api/openapi.json") &&
      (response.ok || response.status === HTTP.notModified)
      ? "public, max-age=0, must-revalidate"
      : "no-store",
  );
  if (publicApi) {
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
    headers.set("access-control-allow-headers", "Accept, If-None-Match");
    headers.set(
      "access-control-expose-headers",
      "X-Request-Id, X-Public-Phonebook-Snapshot, Retry-After, Content-Disposition, Link, ETag, Allow",
    );
  }
  if (!headers.has("x-request-id")) headers.set("x-request-id", id);
  if (request.method === "HEAD") await response.body?.cancel();
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    headers,
  });
}
