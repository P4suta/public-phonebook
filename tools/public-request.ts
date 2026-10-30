import { environments } from "../src/core/environment.ts";

const requestTimeoutMs = 60000;

export interface PublicAccess {
  readonly origin: string;
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
}
export function publicAccess(): PublicAccess {
  return {
    origin: process.env.DIAL_PUBLIC_ORIGIN ?? "",
    clientId: process.env.ACCESS_SERVICE_CLIENT_ID,
    clientSecret: process.env.ACCESS_SERVICE_CLIENT_SECRET,
  };
}

export async function checkedFetch(
  path: string | URL,
  init: RequestInit = {},
  access: PublicAccess = publicAccess(),
  transport: typeof fetch = fetch,
): Promise<Response> {
  if (
    ![environments.staging.origin, environments.production.origin].includes(
      access.origin,
    )
  )
    throw new Error("An exact configured public origin is required");
  const url = new URL(path, access.origin);
  if (url.origin !== access.origin || url.username || url.password)
    throw new Error(
      "Verification cannot forward requests outside its configured origin",
    );
  const headers = new Headers(init.headers);
  for (const name of [
    "cookie",
    "authorization",
    "cf-access-client-id",
    "cf-access-client-secret",
    "cf-access-jwt-assertion",
  ])
    headers.delete(name);
  if (access.origin === environments.staging.origin) {
    if (!access.clientId || !access.clientSecret)
      throw new Error(
        "Staging verification requires its scoped service identity",
      );
    headers.set("CF-Access-Client-Id", access.clientId);
    headers.set("CF-Access-Client-Secret", access.clientSecret);
  }
  headers.set("Accept-Encoding", "identity");
  try {
    return await transport(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    throw new Error("Public verification request failed");
  }
}
