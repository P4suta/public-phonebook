import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest, type Services } from "../../cloudflare/service.ts";

function unused(): Promise<Response> {
  throw new Error("Unexpected service call");
}

test("the edge forwards search parameters and only the headers required by the origin", async () => {
  const seen: Request[] = [];
  const services: Services = {
    assets: unused,
    async origin(request) {
      seen.push(request);
      return new Response("result", {
        headers: {
          "x-request-id": "origin-id",
          "x-public-phonebook-snapshot": "a".repeat(64),
          "cache-control": "public",
        },
      });
    },
  };
  const response = await handleRequest(
    new Request("https://directory.example/?q=private&category=library", {
      headers: {
        cookie: "private=value",
        authorization: "Bearer private",
        "cf-connecting-ip": "192.0.2.1",
        "x-request-id": "untrusted",
        accept: "text/html",
        "if-none-match": '"known"',
      },
    }),
    services,
  );
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0]?.url,
    "http://phonebook.internal/?q=private&category=library",
  );
  assert.deepEqual(Array.from(seen[0]?.headers.keys() ?? []), [
    "accept",
    "if-none-match",
  ]);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-request-id"), "origin-id");
  assert.equal(
    response.headers.get("x-public-phonebook-snapshot"),
    "a".repeat(64),
  );
  assert.equal(await response.text(), "result");
});

test("static requests do not start containers or forward search terms", async () => {
  for (const path of [
    "/style.css",
    "/app.js",
    "/api.js",
    "/icons/search.svg",
    "/fonts/noto-sans-jp.woff2",
  ]) {
    const response = await handleRequest(
      new Request(`https://directory.example${path}?q=private`),
      {
        origin: unused,
        async assets(request) {
          assert.equal(new URL(request.url).search, "");
          assert.equal(
            new URL(request.url).origin,
            "https://directory.example",
          );
          return new Response("asset");
        },
      },
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=0, must-revalidate",
    );
  }
});

test("public API preflight works without contacting the container", async () => {
  const response = await handleRequest(
    new Request("https://directory.example/api/contacts", {
      method: "OPTIONS",
      headers: {
        origin: "https://consumer.example",
        "access-control-request-method": "GET",
      },
    }),
    { origin: unused, assets: unused },
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(
    response.headers.get("access-control-allow-methods"),
    "GET, HEAD, OPTIONS",
  );
  assert.equal(await response.text(), "");
});

test("public API gateway failures retain machine-readable details and browser access", async () => {
  const cases: readonly { request: Request; status: number; code: string }[] = [
    {
      request: new Request("https://directory.example/api/contacts", {
        method: "POST",
      }),
      status: 405,
      code: "method_not_allowed",
    },
    {
      request: new Request(
        `https://directory.example/api/contacts?q=${"字".repeat(1000)}`,
      ),
      status: 400,
      code: "invalid_query",
    },
    {
      request: new Request("https://directory.example/api/contacts?q=private"),
      status: 503,
      code: "unavailable",
    },
  ];
  for (const entry of cases) {
    const response = await handleRequest(entry.request, {
      assets: unused,
      async origin() {
        throw new Error("SQL /private/source.db private");
      },
    });
    assert.equal(response.status, entry.status);
    assert.equal(
      response.headers.get("content-type"),
      "application/problem+json",
    );
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const body: unknown = await response.json();
    assert.ok(
      typeof body === "object" &&
        body !== null &&
        "status" in body &&
        "code" in body &&
        "request_id" in body,
    );
    assert.equal(body.status, entry.status);
    assert.equal(body.code, entry.code);
    assert.equal(body.request_id, response.headers.get("x-request-id"));
    assert.doesNotMatch(JSON.stringify(body), /SQL|private|source.db/);
    if (entry.status === 503)
      assert.equal(response.headers.get("retry-after"), "1");
    if (entry.status === 405)
      assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
  }
});

test("public API responses expose metadata and the schema keeps cache validators", async () => {
  for (const path of ["/api/contacts", "/api/openapi.json"]) {
    const response = await handleRequest(
      new Request(`https://directory.example${path}`),
      {
        assets: unused,
        async origin() {
          return path.endsWith("json")
            ? new Response(null, { status: 304, headers: { etag: '"schema"' } })
            : new Response('{"data":[]}');
        },
      },
    );
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.match(
      response.headers.get("access-control-expose-headers") ?? "",
      /X-Public-Phonebook-Snapshot/,
    );
    assert.equal(
      response.headers.get("cache-control"),
      path.endsWith("json") ? "public, max-age=0, must-revalidate" : "no-store",
    );
  }
});

test("unsupported methods and oversized UTF-8 request targets fail before service invocation", async () => {
  const services = { assets: unused, origin: unused };
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await handleRequest(
      new Request("https://directory.example/", { method }),
      services,
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
  const response = await handleRequest(
    new Request(`https://directory.example/?q=${"字".repeat(1000)}`),
    services,
  );
  assert.equal(response.status, 400);
});

test("origin failures produce a protected recovery page without leaking the error or query", async () => {
  const response = await handleRequest(
    new Request("https://directory.example/?q=private"),
    {
      assets: unused,
      async origin() {
        throw new Error("SQL /private/source.db private");
      },
    },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
  assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
  const body = await response.text();
  assert.match(body, /読みこめませんでした/);
  assert.doesNotMatch(body, /SQL|private|source.db/);
});

test("public API problems survive media type parameters and unexpected errors cancel upstream bodies", async () => {
  const problem = {
    type: "/api/docs#invalid-query",
    title: "Invalid query",
    status: 400,
    code: "invalid_query",
    detail: "Use a category from the catalog",
    instance: "urn:public-phonebook:request:native-api-id",
    request_id: "native-api-id",
    invalid_parameters: [{ name: "category", reason: "Unknown category" }],
  };
  const response = await handleRequest(
    new Request("https://directory.example/api/contacts"),
    {
      assets: unused,
      async origin() {
        return new Response(JSON.stringify(problem), {
          status: 400,
          headers: {
            "content-type": "Application/Problem+JSON; charset=utf-8",
            "x-request-id": "native-api-id",
          },
        });
      },
    },
  );
  assert.deepEqual(await response.json(), problem);
  for (const upstream of [400, 404, 405, 409, 500, 502, 503]) {
    let cancelled = false;
    const reply = await handleRequest(
      new Request("https://directory.example/api/contacts"),
      {
        assets: unused,
        async origin() {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode("SQL /private/source.db"),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: upstream, headers: { "content-type": "text/plain" } },
          );
        },
      },
    );
    assert.equal(reply.status, upstream >= 500 ? 503 : upstream);
    assert.equal(reply.headers.get("content-type"), "application/problem+json");
    assert.equal(reply.headers.get("access-control-allow-origin"), "*");
    assert.equal(cancelled, true);
    assert.doesNotMatch(await reply.text(), /SQL|private|source.db/);
  }
});

test("HEAD requests cancel unused origin streams", async () => {
  let cancelled = false;
  const response = await handleRequest(
    new Request("https://directory.example/export?format=csv", {
      method: "HEAD",
    }),
    {
      assets: unused,
      async origin() {
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    },
  );
  assert.equal(response.body, null);
  assert.equal(cancelled, true);
});

test("export bodies remain streaming and cancellation reaches the origin", async () => {
  let cancelled = false;
  const response = await handleRequest(
    new Request("https://directory.example/export?format=csv"),
    {
      assets: unused,
      async origin() {
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    },
  );
  await response.body?.cancel();
  assert.equal(cancelled, true);
});
