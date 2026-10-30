import { describe, expect, it } from "vitest";
import { checkedFetch } from "../../tools/public-request.ts";

const access = {
  origin: "https://staging.dial.page",
  clientId: "fixture-id",
  clientSecret: "fixture-secret",
};
describe("verification credential boundary", () => {
  it("sends staging credentials only to the exact configured origin and never follows redirects", async () => {
    const response = await checkedFetch(
      "/api",
      {},
      access,
      async (url, init): Promise<Response> => {
        expect(url instanceof Request ? url.url : url.toString()).toBe(
          `${access.origin}/api`,
        );
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).get("CF-Access-Client-Secret")).toBe(
          access.clientSecret,
        );
        return new Response(null, {
          status: 302,
          headers: { location: "https://external.invalid/" },
        });
      },
    );
    expect(response.status).toBe(302);
    let calls = 0;
    await expect(
      checkedFetch(
        "https://external.invalid/",
        {},
        access,
        async (): Promise<Response> => {
          calls += 1;
          return new Response();
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("keeps production anonymous even when staging credentials are inherited", async () => {
    await checkedFetch(
      "/api",
      {
        headers: {
          cookie: "fixture",
          authorization: "fixture",
          "CF-Access-Client-Secret": "fixture",
        },
      },
      { ...access, origin: "https://www.dial.page" },
      async (_url, init): Promise<Response> => {
        const headers = new Headers(init?.headers);
        expect(headers.has("cookie")).toBe(false);
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("CF-Access-Client-Id")).toBe(false);
        expect(headers.has("CF-Access-Client-Secret")).toBe(false);
        return new Response();
      },
    );
  });
  it("refuses incomplete staging credentials", async () => {
    await expect(
      checkedFetch("/api", {}, { origin: access.origin }),
    ).rejects.toThrow();
  });
});
