import { describe, expect, it } from "vitest";
import { withStagingAccess } from "../../src/server/staging-access.ts";

const origin = "https://staging.dial.page";
const issuer = "https://fixture.cloudflareaccess.com";
const reviewer = "reviewer@example.com";
const service = "fixture-service.access";
const bindings = {
  APP_ENV: "staging",
  PUBLIC_ORIGIN: origin,
  ACCESS_ISSUER: issuer,
  ACCESS_AUDIENCE: "fixture-audience",
  ACCESS_REVIEWERS: JSON.stringify([reviewer]),
  ACCESS_SERVICE_CLIENT_ID: service,
};

describe("staging request boundary", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"])
    for (const path of [
      "/",
      "/about",
      "/developers",
      "/api",
      "/api/catalog",
      "/api/datasets",
      "/assets/app.js",
      "/fonts/font.woff2",
      "/icons/tooth.svg",
    ])
      it(`denies anonymous ${method} ${path} before delegation`, async () => {
        let calls = 0;
        const fetch = withStagingAccess(async () => {
          calls += 1;
          return new Response("protected");
        });
        const response = await fetch(
          new Request(`${origin}${path}`, { method }),
          bindings,
        );
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain("protected");
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(calls).toBe(0);
      });

  it("admits only configured identities and removes credentials before dispatch", async () => {
    for (const identity of [{ email: reviewer }, { common_name: service }]) {
      const fetch = withStagingAccess(
        async (request) => {
          for (const header of [
            "cookie",
            "cf-access-jwt-assertion",
            "cf-access-client-id",
            "cf-access-client-secret",
          ])
            expect(request.headers.has(header)).toBe(false);
          return new Response("protected", {
            headers: { "cache-control": "public, max-age=31536000" },
          });
        },
        async () => ({ type: "app", ...identity }),
      );
      const response = await fetch(
        new Request(origin, {
          headers: {
            "cf-access-jwt-assertion": "a.b.c",
            cookie: "CF_Authorization=fixture",
            "cf-access-client-id": service,
            "cf-access-client-secret": "fixture",
          },
        }),
        bindings,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(
        "private, no-store, no-transform",
      );
    }
  });

  it("refuses unknown identities, aliases, malformed configuration and unknown environments", async () => {
    const fetch = withStagingAccess(
      async () => new Response("protected"),
      async () => ({ type: "app", email: "outsider@example.com" }),
    );
    const request = new Request(origin, {
      headers: { "cf-access-jwt-assertion": "a.b.c" },
    });
    expect((await fetch(request, bindings)).status).toBe(403);
    expect(
      (
        await fetch(
          new Request("https://alternate.workers.dev", {
            headers: request.headers,
          }),
          bindings,
        )
      ).status,
    ).toBe(403);
    expect(
      (await fetch(request, { ...bindings, ACCESS_AUDIENCE: "" })).status,
    ).toBe(503);
    expect(
      (await fetch(request, { ...bindings, APP_ENV: "unknown" })).status,
    ).toBe(503);
  });

  it("preserves anonymous development and production without invoking verification", async () => {
    for (const environment of ["development", "production"]) {
      const fetch = withStagingAccess(
        async () => new Response("public"),
        async () => {
          throw new Error("Verification must not run");
        },
      );
      expect(
        await (
          await fetch(new Request(origin), {
            ...bindings,
            APP_ENV: environment,
          })
        ).text(),
      ).toBe("public");
    }
  });
});
