import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import { httpStatus } from "./core/http-status.ts";
import { parseSearchString, parseWebSearch } from "./core/web-search.ts";
import { api } from "./server/api.ts";
import type { DirectoryBindings } from "./server/bindings.ts";
import { withStagingAccess } from "./server/staging-access.ts";

const cspNonceBytes = 24;
const successfulStatusCeiling = 300;

const start = createStartHandler(defaultStreamHandler);

export default {
  fetch: withStagingAccess(async function fetch(
    request: Request,
    bindings: DirectoryBindings,
    context?: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/"))
      return api.fetch(request, bindings, context);
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Use GET or HEAD", {
        status: httpStatus.methodNotAllowed,
        headers: { Allow: "GET, HEAD" },
      });
    const asset = await bindings.ASSETS.fetch(request);
    if (asset.status !== httpStatus.notFound) return asset;
    await asset.body?.cancel();
    const nonce = btoa(
      String.fromCharCode(
        ...crypto.getRandomValues(new Uint8Array(cspNonceBytes)),
      ),
    );
    const headers = new Headers(request.headers);
    headers.set("x-dial-nonce", nonce);
    const internal = new Request(request, { headers });
    const response = await start(internal, { context: { nonce } });
    const invalid =
      url.pathname === "/" && !parseWebSearch(parseSearchString(url.search)).ok;
    const result = new Response(
      request.method === "HEAD" ? null : response.body,
      {
        status:
          invalid && response.status < successfulStatusCeiling
            ? httpStatus.badRequest
            : response.status,
        headers: response.headers,
      },
    );
    const reference = url.pathname === "/developers";
    const styleSources = reference
      ? "'self' 'unsafe-inline'"
      : `'self' 'nonce-${nonce}'`;
    const styleAttributes = reference
      ? "'unsafe-inline'"
      : "'unsafe-hashes' 'sha256-3oFxofzq3N//6J8H86e9ul4WT2OkJrtonB66gn/TLJw='";
    result.headers.set(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src ${styleSources}; style-src-attr ${styleAttributes}; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    result.headers.set("X-Content-Type-Options", "nosniff");
    result.headers.set("Referrer-Policy", "no-referrer");
    result.headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    result.headers.set("Cache-Control", "no-store, no-transform");
    return result;
  }),
} satisfies ExportedHandler<DirectoryBindings>;
