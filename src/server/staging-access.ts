import {
  createRemoteJWKSet,
  customFetch,
  type JWTPayload,
  jwtVerify,
} from "jose";
import * as v from "valibot";
import { EnvironmentSchema, environments } from "../core/environment.ts";
import { httpStatus } from "../core/http-status.ts";
import { stagingAdmission } from "../core/staging-access-policy.ts";

const maximumAssertionLength = 16384;
const jwksTimeoutMs = 5000;
const privateCache = "private, no-store, no-transform";
const credentialHeaders = [
  "cookie",
  "cf-access-jwt-assertion",
  "cf-access-client-id",
  "cf-access-client-secret",
  "authorization",
];

export const AccessConfigurationSchema = v.object({
  PUBLIC_ORIGIN: v.literal(environments.staging.origin),
  ACCESS_ISSUER: v.pipe(
    v.string(),
    v.regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u),
  ),
  ACCESS_AUDIENCE: v.pipe(v.string(), v.minLength(1)),
  ACCESS_REVIEWERS: v.pipe(
    v.string(),
    v.transform((text): unknown => JSON.parse(text)),
    v.array(v.pipe(v.string(), v.email())),
    v.minLength(1),
  ),
  ACCESS_SERVICE_CLIENT_ID: v.pipe(v.string(), v.minLength(1)),
});
export type AccessConfiguration = v.InferOutput<
  typeof AccessConfigurationSchema
>;
export type AccessVerifier = (
  assertion: string,
  configuration: AccessConfiguration,
) => Promise<JWTPayload>;
type RequestHandler<Bindings> = (
  request: Request,
  bindings: Bindings,
  context?: ExecutionContext,
) => Promise<Response>;

export function createAccessVerifier(
  fetchImplementation: typeof fetch = fetch,
): AccessVerifier {
  const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  return async (assertion, configuration): Promise<JWTPayload> => {
    let key = keys.get(configuration.ACCESS_ISSUER);
    if (!key) {
      key = createRemoteJWKSet(
        new URL(`${configuration.ACCESS_ISSUER}/cdn-cgi/access/certs`),
        {
          [customFetch]: fetchImplementation,
          timeoutDuration: jwksTimeoutMs,
        },
      );
      keys.set(configuration.ACCESS_ISSUER, key);
    }
    const { payload } = await jwtVerify(assertion, key, {
      issuer: configuration.ACCESS_ISSUER,
      audience: configuration.ACCESS_AUDIENCE,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "iss", "aud"],
      maxTokenAge: "4h",
    });
    return payload;
  };
}

function denied(request: Request, status: number): Response {
  return new Response(
    request.method === "HEAD" ? null : "Staging access is unavailable.",
    {
      status,
      headers: {
        "Cache-Control": privateCache,
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

export function withStagingAccess<Bindings>(
  handler: RequestHandler<Bindings>,
  verify: AccessVerifier = createAccessVerifier(),
): RequestHandler<Bindings> {
  return async (request, bindings, context): Promise<Response> => {
    const raw: unknown = bindings;
    const environment = v.safeParse(
      v.object({ APP_ENV: EnvironmentSchema }),
      raw,
    );
    if (!environment.success) return denied(request, httpStatus.unavailable);
    if (environment.output.APP_ENV !== "staging")
      return handler(request, bindings, context);
    let configuration: AccessConfiguration;
    try {
      configuration = v.parse(AccessConfigurationSchema, raw);
    } catch {
      return denied(request, httpStatus.unavailable);
    }
    const canonicalOrigin =
      new URL(request.url).origin === configuration.PUBLIC_ORIGIN;
    const assertion = request.headers.get("cf-access-jwt-assertion");
    if (
      !canonicalOrigin ||
      !assertion ||
      assertion.length > maximumAssertionLength
    )
      return denied(request, httpStatus.forbidden);
    let identityAllowed = false;
    try {
      const payload = await verify(assertion, configuration);
      identityAllowed =
        payload.type === "app" &&
        ((typeof payload.email === "string" &&
          configuration.ACCESS_REVIEWERS.includes(
            payload.email.toLowerCase(),
          )) ||
          payload.common_name === configuration.ACCESS_SERVICE_CLIENT_ID);
    } catch {
      return denied(request, httpStatus.forbidden);
    }
    if (!stagingAdmission(true, true, canonicalOrigin, true, identityAllowed))
      return denied(request, httpStatus.forbidden);
    const headers = new Headers(request.headers);
    for (const header of credentialHeaders) headers.delete(header);
    const response = await handler(
      new Request(request, { headers }),
      bindings,
      context,
    );
    const result = new Response(response.body, response);
    result.headers.set("Cache-Control", privateCache);
    result.headers.delete("Set-Cookie");
    return result;
  };
}
