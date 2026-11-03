import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The entry passes each request through a binding as `src/server.ts` passes it to `ASSETS`, and `/legacy` rebuilds it the way the entry did before.
const entry = `
import { pageRequest } from "./page-request.js";
export default {
  async fetch(request, env) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    await asset.body?.cancel();
    const legacy = new URL(request.url).pathname === "/legacy";
    try {
      const page = legacy
        ? new Request(request, { headers: new Headers(request.headers) })
        : pageRequest(request, "nonce");
      const summary = JSON.stringify({
        method: page.method,
        nonce: page.headers.get("x-dial-nonce"),
        bodyless: page.body === null,
      });
      return new Response(request.method === "HEAD" ? null : summary, {
        headers: { "x-page": summary },
      });
    } catch (error) {
      return new Response(String(error), { status: 500 });
    }
  },
};
`;
const assets = `
export default {
  async fetch(request) {
    await request.arrayBuffer();
    return new Response(null, { status: 404 });
  },
};
`;

interface Answer {
  readonly status: number;
  readonly page: string | undefined;
  readonly text: string;
}

/** Sends raw HTTP, because a fetch `Request` refuses a `GET` or `HEAD` body that a client can still send. */
async function send(
  origin: URL,
  path: string,
  method: "GET" | "HEAD",
  body: string | null,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      new URL(path, origin),
      {
        method,
        headers:
          body === null
            ? {}
            : {
                "content-length": String(
                  new TextEncoder().encode(body).byteLength,
                ),
              },
      },
      (incoming) => {
        incoming.setEncoding("utf8");
        let text = "";
        incoming.on("data", (chunk: string) => {
          text += chunk;
        });
        incoming.on("end", () => {
          const page = incoming.headers["x-page"];
          resolve({
            status: incoming.statusCode ?? 0,
            page: typeof page === "string" ? page : undefined,
            text,
          });
        });
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    if (body !== null) outgoing.write(body);
    outgoing.end();
  });
}

let runtime: Miniflare;
let origin: URL;
beforeAll(async () => {
  runtime = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    enableDevRegistry: false,
    unsafeEnableSharedStorage: false,
    workers: [
      {
        config: {
          name: "pages",
          compatibilityDate: "2026-10-29",
          manifest: {
            mainModule: "entry.js",
            modules: {
              "entry.js": { type: "esm", contents: entry },
              "page-request.js": {
                type: "esm",
                contents: stripTypeScriptTypes(
                  await readFile("src/server/page-request.ts", "utf8"),
                ),
              },
            },
          },
          env: { ASSETS: { type: "worker", worker: "assets" } },
        },
      },
      {
        config: {
          name: "assets",
          compatibilityDate: "2026-10-29",
          manifest: {
            mainModule: "assets.js",
            modules: { "assets.js": { type: "esm", contents: assets } },
          },
          env: {},
        },
      },
    ],
  });
  origin = await runtime.ready;
});
afterAll(async () => {
  await runtime.dispose();
});

describe("server-rendering request", () => {
  it("renders GET and HEAD page requests whether or not they carry a body", async () => {
    for (const [method, body] of [
      ["GET", null],
      ["GET", ""],
      ["GET", "x"],
      ["HEAD", null],
      ["HEAD", "x"],
    ] as const) {
      const answer = await send(origin, "/", method, body);
      expect(answer.status, `${method} ${JSON.stringify(body)}`).toBe(200);
      expect(JSON.parse(answer.page ?? "null")).toEqual({
        method,
        nonce: "nonce",
        bodyless: true,
      });
    }
  });

  it("keeps the control: rebuilding from the incoming request fails once a binding consumed its body", async () => {
    expect((await send(origin, "/legacy", "GET", null)).status).toBe(200);
    const failed = await send(origin, "/legacy", "GET", "x");
    expect(failed.status).toBe(500);
    expect(failed.text).toContain(
      "Cannot reconstruct a Request with a used body",
    );
  });
});
