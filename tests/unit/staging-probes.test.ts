import { describe, expect, it } from "vitest";
import { deniesAnonymousRequest } from "../../tools/staging-probes.ts";

function response(
  status: number,
  headers: Record<string, string> = {},
): Pick<Response, "status" | "headers"> {
  return { status, headers: new Headers(headers) };
}

describe("anonymous staging probes", () => {
  it("accepts Access redirects and rejections for every method", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"])
      for (const status of [302, 303, 401, 403])
        expect(deniesAnonymousRequest(method, response(status))).toBe(true);
  });

  it("accepts the Access edge page for an OPTIONS request without preflight headers", () => {
    expect(
      deniesAnonymousRequest(
        "OPTIONS",
        response(400, { "content-type": "text/html; charset=UTF-8" }),
      ),
    ).toBe(true);
  });

  it("rejects responses that reached the Worker or served content", () => {
    for (const [method, candidate] of [
      ["GET", response(400)],
      ["HEAD", response(400)],
      [
        "OPTIONS",
        response(400, { "content-security-policy": "default-src 'none'" }),
      ],
      ["OPTIONS", response(400, { "x-request-id": "request" })],
      ["OPTIONS", response(200)],
      ["OPTIONS", response(204)],
      ["GET", response(200)],
    ] as const)
      expect(deniesAnonymousRequest(method, candidate), method).toBe(false);
  });
});
