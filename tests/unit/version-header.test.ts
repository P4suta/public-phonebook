import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { versionHeader } from "../../src/server/version-header.ts";

const entry = `
import { withVersionHeader } from "./version-header.js";
export default {
  fetch: withVersionHeader(async (request, env) => {
    const url = new URL(request.url);
    if (url.pathname === "/id") return new Response(env.CF_VERSION_METADATA?.id ?? "none");
    if (url.pathname === "/redirect") return Response.redirect("https://www.dial.page/", 301);
    if (url.pathname === "/probe") {
      try {
        Response.redirect("https://www.dial.page/", 301).headers.set("x-probe", "1");
        return new Response("mutable");
      } catch (error) {
        return new Response(error instanceof TypeError ? "immutable" : "other");
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Use GET or HEAD", { status: 405 });
    return new Response(request.method === "HEAD" ? null : "page", { status: 404 });
  }),
};
`;

async function runtime(binding: boolean): Promise<Miniflare> {
  const wrapper = stripTypeScriptTypes(
    await readFile("src/server/version-header.ts", "utf8"),
  );
  return new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    enableDevRegistry: false,
    unsafeEnableSharedStorage: false,
    workers: [
      {
        config: {
          name: binding ? "versioned" : "unversioned",
          compatibilityDate: "2026-10-29",
          manifest: {
            mainModule: "entry.js",
            modules: {
              "entry.js": { type: "esm", contents: entry },
              "version-header.js": { type: "esm", contents: wrapper },
            },
          },
          env: binding
            ? { CF_VERSION_METADATA: { type: "version-metadata" } }
            : {},
        },
      },
    ],
  });
}

let versioned: Miniflare;
let unversioned: Miniflare;
beforeAll(async () => {
  versioned = await runtime(true);
  unversioned = await runtime(false);
});
afterAll(async () => {
  await versioned.dispose();
  await unversioned.dispose();
});

describe("Worker version header", () => {
  it("names the answering version on mutable, immutable, refused, and HEAD responses", async () => {
    const identity = await versioned.dispatchFetch("http://localhost/id");
    const id = await identity.text();
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(identity.headers.get(versionHeader)).toBe(id);
    for (const [path, method, status] of [
      ["/redirect", "GET", 301],
      ["/missing", "GET", 404],
      ["/missing", "HEAD", 404],
      ["/missing", "POST", 405],
    ] as const) {
      const response = await versioned.dispatchFetch(
        `http://localhost${path}`,
        { method, redirect: "manual" },
      );
      await response.arrayBuffer();
      expect(response.status, `${method} ${path}`).toBe(status);
      expect(response.headers.get(versionHeader), `${method} ${path}`).toBe(id);
    }
    const redirect = await versioned.dispatchFetch(
      "http://localhost/redirect",
      {
        redirect: "manual",
      },
    );
    await redirect.arrayBuffer();
    expect(redirect.headers.get("Location")).toBe("https://www.dial.page/");
    const probe = await versioned.dispatchFetch("http://localhost/probe");
    expect(await probe.text()).toBe("immutable");
  });

  it("omits the header when the runtime gives no version metadata", async () => {
    const response = await unversioned.dispatchFetch("http://localhost/id");
    expect(await response.text()).toBe("none");
    expect(response.headers.has(versionHeader)).toBe(false);
  });

  it("wraps the whole Worker entry, so assets and errors carry the version", async () => {
    const source = await readFile("src/server.ts", "utf8");
    expect(source).toMatch(/fetch: withVersionHeader\(async function fetch\(/u);
  });
});
