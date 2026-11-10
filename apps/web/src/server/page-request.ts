const nonceHeader = "x-dial-nonce";

/**
 * Builds the request that server rendering reads from a `GET` or `HEAD` page request.
 * It carries no body, because the assets binding may already have consumed the incoming one, and workerd refuses to rebuild a request from a used body.
 */
export function pageRequest(request: Request, nonce: string): Request {
  const headers = new Headers(request.headers);
  headers.set(nonceHeader, nonce);
  return new Request(request.url, {
    method: request.method,
    headers,
    signal: request.signal,
  });
}
